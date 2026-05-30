require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const Anthropic  = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app  = express();
const port = process.env.PORT || 3001;

// ── Clients ──────────────────────────────────────────────────────────────────
const pitchingClient = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY_PITCHING });
const battingClient  = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY_BATTING  });

// ── Email transporter (Gmail) ─────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'fixnetworkpc@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const OWNER_EMAIL  = 'fixnetworkpc@gmail.com';
const SENDER_EMAIL = 'fixnetworkpc@gmail.com';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '60mb' }));

const analysisLimiter = rateLimit({ windowMs: 15*60*1000, max: 30,
  message: { message: 'Too many requests. Please wait a few minutes.' } });

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Baseball Mechanics API' }));

// ── Prompts ───────────────────────────────────────────────────────────────────
const PITCHING_PROMPT = `You are an expert baseball pitching coach and biomechanics analyst with 25+ years of experience. You specialize in arm health, injury prevention, and sustainable mechanics for players aged 8-18. Your mechanical analysis is benchmarked against these 10 MLB pitchers:

1. GREG MADDUX — Textbook hip-to-shoulder separation, elbow always in front, glove tucked, spine straight. 23 seasons, minimal arm issues.
2. CLAYTON KERSHAW — Elite balance point, exceptional hip hinge, upper-90s hip-shoulder separation, arm path on-line, deceleration across body.
3. JUSTIN VERLANDER — Controlled rocker step, balanced leg lift, hip rotation before shoulder, late loose arm swing, strong follow-through.
4. NOLAN RYAN — 27 seasons. Maximum hip-shoulder separation, full lower-half drive, efficient arm path, tremendous follow-through.
5. PEDRO MARTINEZ — Explosive hip rotation, compact arm path, glove tight to chest, elite extension, safe deceleration.
6. TOM SEAVER — Drop-and-drive lower half, powerful back leg push, spine angle maintained, hips before shoulder turn.
7. SANDY KOUFAX — Pure arm path, exceptional hip-shoulder separation, balanced upright posture, full extension, clean follow-through.
8. MAX SCHERZER — Strong balance point, arm in power zone, glove side disciplined, follow-through decelerates across body.
9. LOGAN WEBB — Clean repeatable mechanics, minimal wasted movement, low arm stress per outing.
10. MARIANO RIVERA — Most repeatable delivery ever: same arm path every pitch, excellent glove side, textbook deceleration.

Shared standards: lower half leads, balanced leg lift, stride toward plate, elbow at/above shoulder when cocked, hip-shoulder separation, arm in power zone, glove side tucked, arm decelerates across body, spine maintained.

Respond ONLY with valid JSON (no markdown, no preamble):
{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark pitchers this resembles.","armHealthRisk":"LOW","armHealthNote":"1-2 sentences on arm safety.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which pitcher and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 8","detail":"Thorough explanation with benchmark comparison.","mlbExample":"Specific benchmark pitcher who does this correctly.","drill":"Named drill with step-by-step."}],"coachNote":"2-3 sentence honest encouraging close."}
armHealthRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;

const BATTING_PROMPT = `You are an expert baseball hitting coach and biomechanics analyst with 25+ years of experience. You specialize in swing mechanics, injury prevention, and performance for players aged 8-18. Your analysis is benchmarked against these 10 MLB hitters:

1. TED WILLIAMS — Perfect hip-to-shoulder separation, hips before hands, level swing plane, head still, full extension.
2. MIKE TROUT — Explosive hip rotation, exceptional separation, short direct hand path, spine angle through contact.
3. KEN GRIFFEY JR. — Fluid load, smooth stride, elite hip rotation timing, flat bat path, full extension, iconic high finish.
4. TONY GWYNN — Short compact load, hands inside the ball, bat in the zone longest, consistent contact all fields.
5. HANK AARON — Quiet stance, simple load, exceptional wrist action, hips driving the swing. Efficient power.
6. ALBERT PUJOLS — Strong stable base, powerful hip rotation, exceptional launch position, extension. 20+ seasons.
7. GEORGE BRETT — Balanced stance, controlled load, excellent hip rotation, bat path through zone, all fields.
8. BARRY BONDS — Most explosive hip rotation in modern baseball, short hand path, incredible extension.
9. FRANK THOMAS — Wide athletic stance, strong load, powerful hip drive, exceptional extension.
10. FREDDIE FREEMAN — Excellent load and timing, hip rotation, drives everywhere, balanced follow-through.

Respond ONLY with valid JSON (no markdown, no preamble):
{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark hitters this resembles.","injuryRisk":"LOW","healthNote":"1-2 sentences on wrist/elbow/shoulder stress.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which hitter and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 7","detail":"Thorough explanation.","mlbExample":"Specific benchmark hitter who does this correctly.","drill":"Named drill with step-by-step."}],"coachNote":"2-3 sentence honest encouraging close."}
injuryRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;

// ── JSON repair ───────────────────────────────────────────────────────────────
function extractJSON(raw) {
  let s = raw.replace(/```json|```/g,'').trim();
  const start = s.indexOf('{'); if (start===-1) throw new Error('No JSON in response');
  s = s.slice(start);
  const end = s.lastIndexOf('}'); if (end===-1) throw new Error('JSON truncated');
  s = s.slice(0,end+1);
  try { return JSON.parse(s); } catch(_) {}
  s = s.replace(/[\x00-\x1F\x7F]/g,m=>m==='\n'?'\\n':m==='\t'?'\\t':'');
  const stack=[]; let inStr=false,escape=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i]; if(escape){escape=false;continue;} if(ch==='\\'){escape=true;continue;}
    if(ch==='"'){inStr=!inStr;continue;} if(inStr) continue;
    if(ch==='{')stack.push('}'); else if(ch==='[')stack.push(']'); else if(ch==='}'||ch===']')stack.pop();
  }
  if(inStr)s+='"'; s=s.replace(/,\s*([}\]])/g,'$1'); while(stack.length)s+=stack.pop();
  return JSON.parse(s);
}

// ── Analysis endpoint ─────────────────────────────────────────────────────────
app.post('/analyze', analysisLimiter, async (req, res) => {
  const { mode, playerName, frames, userInfo } = req.body;
  if (!frames?.length)                           return res.status(400).json({ message: 'No frames provided' });
  if (!['pitching','batting'].includes(mode))    return res.status(400).json({ message: 'Invalid mode' });

  const client       = mode==='pitching' ? pitchingClient : battingClient;
  const systemPrompt = mode==='pitching' ? PITCHING_PROMPT : BATTING_PROMPT;

  const content = frames.map(f => ({
    type: 'image', source: { type:'base64', media_type:'image/jpeg', data: f.base64 },
  }));
  const name = playerName?.trim() ? `${mode==='pitching'?'Pitcher':'Batter'}: ${playerName.trim()}. ` : '';
  const seq  = frames.map((f,i)=>`Frame ${i+1}: ${f.label}`).join(' | ');
  content.push({ type:'text', text:`${name}${frames.length} frames: ${seq}. Analyze all frames and return full JSON breakdown.` });

  try {
    const message = await client.messages.create({
      model:'claude-sonnet-4-6', max_tokens:4000, system:systemPrompt,
      messages:[{ role:'user', content }],
    });
    const raw      = message.content.map(b=>b.text||'').join('').trim();
    const analysis = extractJSON(raw);
    res.json({ analysis });
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ message: err.message || 'Analysis failed' });
  }
});

// ── Send results email to user ────────────────────────────────────────────────
app.post('/send-results', async (req, res) => {
  const { userEmail, userName, userRole, playerName, mode, analysis: d, benchmarks, timestamp } = req.body;
  if (!userEmail || !d) return res.status(400).json({ message: 'Missing required fields' });

  const PT = { CRITICAL:'⚠ CRITICAL', HIGH:'↑ HIGH', MEDIUM:'→ MEDIUM', LOW:'↓ LOW' };
  const risk = (d.armHealthRisk||d.injuryRisk||'').toUpperCase();
  const modeLabel = mode==='pitching' ? 'Pitching' : 'Batting';
  const riskColors = { LOW:'#2ecc71', MODERATE:'#e67e22', HIGH:'#e74c3c' };
  const riskColor  = riskColors[risk] || '#b8943a';
  const gradeColors = { A:'#2ecc71',B:'#27ae60',C:'#f1c40f',D:'#e67e22',F:'#e74c3c' };
  const gradeColor = gradeColors[d.overallGrade] || '#b8943a';

  const oppsHtml = (d.opportunities||[]).map((o,i) => `
    <div style="background:#fff8f5;border-left:4px solid #e74c3c;border-radius:6px;padding:14px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:bold;color:#c0392b;border:1px solid #c0392b;padding:2px 8px;border-radius:3px">${PT[o.priority]||o.priority}</span>
        <span style="font-size:14px;font-weight:bold;color:#111">${o.title}</span>
        ${o.frameRef?`<span style="font-size:11px;color:#666;margin-left:auto">📷 ${o.frameRef}</span>`:''}
      </div>
      <p style="color:#333;font-size:13px;line-height:1.6;margin-bottom:10px">${o.detail}</p>
      ${o.mlbExample?`<div style="background:#fdf8e8;border:1px solid #d4b040;border-radius:4px;padding:8px;margin-bottom:8px;font-size:12px;color:#5a4800"><strong>⚾ MLB Benchmark:</strong> ${o.mlbExample}</div>`:''}
      <div style="background:#f0f4f8;border:1px solid #ccc;border-radius:4px;padding:8px;font-size:12px;color:#1a3a6a"><strong>🏋️ Drill / Fix:</strong> ${o.drill}</div>
    </div>`).join('');

  const strsHtml = (d.strengths||[]).map(s => `
    <div style="background:#efffee;border-left:4px solid #2ecc71;border-radius:6px;padding:14px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:bold;color:#1a7a40;margin-bottom:6px">✓ ${s.title}</div>
      <p style="color:#333;font-size:13px;line-height:1.6">${s.detail}</p>
      ${s.mlbMatch?`<p style="font-size:12px;color:#2a6a40;font-style:italic;margin-top:6px">⚾ ${s.mlbMatch}</p>`:''}
    </div>`).join('');

  const htmlBody = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif">
<div style="max-width:640px;margin:0 auto;background:#fff">

  <!-- Header -->
  <div style="background:#07090f;padding:24px 28px;border-bottom:3px solid #b8943a">
    <h1 style="color:#fff;font-size:20px;letter-spacing:.06em;margin:0">⚾ BASEBALL MECHANICS</h1>
    <p style="color:#4a6080;font-size:10px;letter-spacing:.16em;text-transform:uppercase;margin:4px 0 0">AI-Powered · MLB Benchmarked</p>
  </div>

  <!-- Greeting -->
  <div style="padding:24px 28px 0">
    <p style="font-size:15px;color:#333;line-height:1.6">Hi ${userName},</p>
    <p style="font-size:14px;color:#555;line-height:1.6;margin-top:8px">
      Your <strong>${modeLabel} Mechanics Analysis</strong> for <strong>${playerName||userName}</strong> is complete.
      Here's the full breakdown below. You can also open the app to share or save the full PDF version.
    </p>
  </div>

  <!-- Scorecard -->
  <div style="margin:20px 28px;background:#f0f8f0;border:2px solid #2ecc71;border-radius:10px;padding:20px;display:flex;gap:16px">
    <div style="text-align:center;flex-shrink:0">
      <div style="width:64px;height:64px;border-radius:50%;border:3px solid ${gradeColor};background:#e8f8ee;display:inline-flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold;color:${gradeColor}">${d.overallGrade}</div>
      <p style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.1em;margin:4px 0 0">Overall</p>
    </div>
    <div style="flex:1">
      <p style="font-size:14px;line-height:1.6;color:#111;margin-bottom:12px">${d.overallSummary}</p>
      <span style="display:inline-block;padding:4px 12px;border-radius:12px;border:1px solid ${riskColor};color:${riskColor};font-size:11px;font-weight:bold">${mode==='pitching'?'Arm Health Risk':'Injury Risk'}: ${risk}</span>
      ${(d.armHealthNote||d.healthNote)?`<p style="font-size:12px;font-style:italic;color:#555;margin-top:8px">${d.armHealthNote||d.healthNote}</p>`:''}
    </div>
  </div>

  <!-- Benchmarks -->
  <div style="margin:0 28px 20px;background:#fdf8e8;border:1px solid #c8a030;border-radius:6px;padding:12px">
    <p style="font-size:10px;color:#8a6a1a;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">⚾ Benchmarked Against</p>
    <p style="font-size:12px;color:#5a4a10">${benchmarks}</p>
  </div>

  <!-- Opportunities -->
  <div style="padding:0 28px">
    <h2 style="font-size:16px;border-bottom:2px solid #c8a030;padding-bottom:8px;margin-bottom:14px;color:#111">
      Opportunities (${(d.opportunities||[]).length})
    </h2>
    ${oppsHtml}
  </div>

  <!-- Strengths -->
  <div style="padding:0 28px;margin-top:20px">
    <h2 style="font-size:16px;border-bottom:2px solid #2ecc71;padding-bottom:8px;margin-bottom:14px;color:#111">
      Strengths (${(d.strengths||[]).length})
    </h2>
    ${strsHtml}
  </div>

  <!-- Coach Note -->
  ${d.coachNote?`
  <div style="margin:20px 28px;background:#fdf8e8;border-top:3px solid #c8a030;border:1px solid #d4c080;border-top:3px solid #c8a030;border-radius:8px;padding:16px">
    <p style="font-size:10px;color:#8a6a1a;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">🎓 Final Note</p>
    <p style="font-size:14px;font-style:italic;color:#333;line-height:1.7">"${d.coachNote}"</p>
  </div>`:''}

  <!-- Footer -->
  <div style="background:#07090f;padding:20px 28px;margin-top:28px;text-align:center">
    <p style="color:#4a6080;font-size:11px;margin:0">
      Generated by Baseball Mechanics App · ${new Date(timestamp||Date.now()).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}
    </p>
    <p style="color:#2a4060;font-size:10px;margin:6px 0 0">
      Questions? Reply to this email — we'll get back to you personally.
    </p>
  </div>

</div>
</body></html>`;

  try {
    await mailer.sendMail({
      from:    `"Baseball Mechanics App" <${SENDER_EMAIL}>`,
      to:      userEmail,
      subject: `⚾ Your ${modeLabel} Analysis Results — ${playerName||userName}`,
      html:    htmlBody,
    });
    // Notify owner of paid analysis (for outreach purposes)
    const tier = req.body.tier || 'free';
    if (tier !== 'free') {
      await mailer.sendMail({
        from:    `"Baseball Mechanics App" <${SENDER_EMAIL}>`,
        to:      OWNER_EMAIL,
        subject: `[Paid User] ${modeLabel} Analysis — ${playerName||userName} (${userEmail})`,
        text:    `Paid user completed an analysis.\n\nUser: ${userName}\nEmail: ${userEmail}\nRole: ${userRole}\nMode: ${modeLabel}\nPlayer: ${playerName}\nTier: ${tier}\nDate: ${new Date().toISOString()}`,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ message: 'Email failed: ' + err.message });
  }
});

// ── Error reporting endpoint ──────────────────────────────────────────────────
app.post('/report-error', async (req, res) => {
  const { timestamp, appVersion, platform, osVersion, context,
          errorMessage, errorStack, userEmail, userName, userRole } = req.body;

  const text = `
BASEBALL MECHANICS APP — ERROR REPORT
======================================
Time:        ${timestamp || new Date().toISOString()}
App Version: ${appVersion || 'unknown'}
Platform:    ${platform || 'unknown'} (OS: ${osVersion || 'unknown'})
Context:     ${context || 'unknown'}

USER
----
Name:  ${userName  || 'unknown'}
Email: ${userEmail || 'not provided'}
Role:  ${userRole  || 'unknown'}

ERROR
-----
Message: ${errorMessage}

Stack Trace:
${errorStack || 'No stack available'}
`;

  try {
    await mailer.sendMail({
      from:    `"Baseball Mechanics Error Reporter" <${SENDER_EMAIL}>`,
      to:      OWNER_EMAIL,
      subject: `🚨 App Error: ${errorMessage?.substring(0,60) || 'Unknown error'} (${platform||'?'})`,
      text,
    });
    res.json({ received: true });
  } catch (err) {
    console.error('Error report email failed:', err.message);
    res.status(500).json({ message: 'Could not send error report' });
  }
});

app.listen(port, () => console.log(`Baseball Mechanics API running on port ${port}`));
