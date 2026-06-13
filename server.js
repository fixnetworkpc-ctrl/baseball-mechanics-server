require("dotenv").config();
const crypto  = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");

// ── Benchmark data (edit benchmarks.json to update drills and archetypes) ─────
const _b = require('./benchmarks.json');
const DRILL_LIBRARY    = _b.drills;
const CLASSIC_PITCHERS = _b.classicPitchers;
const CURRENT_PITCHERS = _b.currentPitchers;
const CLASSIC_BATTERS  = _b.classicBatters;
const CURRENT_BATTERS  = _b.currentBatters;

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; required for express-rate-limit and correct IP resolution
const port = process.env.PORT || 3001;

// ── Security constants ────────────────────────────────────────────────────────
const APP_SECRET = process.env.APP_SECRET;
const MAX_FRAMES = 24;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY });
const mailer = nodemailer.createTransport({ service: "gmail", auth: { user: "fixnetworkpc@gmail.com", pass: process.env.GMAIL_APP_PASSWORD } });
const OWNER_EMAIL = "baseballmsupport@gmail.com";

// ── Security helpers ─────────────────────────────────────────────────────────

function requireAppSecret(req, res, next) {
  if (!APP_SECRET) return next();
  if (req.headers["x-app-secret"] !== APP_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function sanitizePlayerName(name) {
  if (!name) return "";
  return String(name).replace(/[^\w\s\-'.]/g, "").slice(0, 60).trim();
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── Middleware ───────────────────────────────────────────────────────────────
// CORS: mobile apps don't send an Origin header, so the request arrives as
// null/undefined — allowing null covers the React Native fetch case while
// blocking browser-based abuse from arbitrary websites.
app.use(cors({
  origin: (origin, cb) => {
    // Allow: React Native (no origin), Render health checks (no origin)
    // Block: cross-origin browser requests from unknown domains
    if (!origin || origin === "null") return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "60mb" }));
app.use(express.urlencoded({ extended: true }));

const analyzeLimiter = rateLimit({ windowMs: 15*60*1000, max: 30,  message: { message: "Too many requests." } });
const emailLimiter   = rateLimit({ windowMs: 60*60*1000, max: 20,  message: { message: "Too many requests." } });
const errorLimiter    = rateLimit({ windowMs: 60*60*1000, max: 50,  message: { message: "Too many requests." } });
const feedbackLimiter = rateLimit({ windowMs: 60*60*1000, max: 10,  message: "<p>Too many submissions. Please try again later.</p>" });

function buildDrillList(mode) {
  return DRILL_LIBRARY[mode]
    .map((d, i) => `${i + 1}. ${d.name} [${d.mechanic}]`)
    .join(" | ");
}

function injectDrillData(analysis, mode) {
  const library = DRILL_LIBRARY[mode] || [];
  if (!analysis.opportunities) return analysis;
  analysis.opportunities = analysis.opportunities.map(opp => {
    const raw = (opp.drillName || "").trim().toLowerCase();
    if (!raw) return opp;
    const match = library.find(d => {
      const lib = d.name.toLowerCase();
      return lib === raw ||
        lib.startsWith(raw.slice(0, 14)) ||
        raw.startsWith(lib.slice(0, 14));
    });
    if (match) {
      opp.drillData = {
        name: match.name,
        description: match.description,
        searchQuery: match.searchQuery,
      };
    }
    return opp;
  });
  return analysis;
}

// ── Pitcher benchmark data ────────────────────────────────────────────────────

function selectPitchers() {
  const classic = [...CLASSIC_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  const current = [...CURRENT_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  return [...classic, ...current].sort(() => Math.random() - 0.5);
}

// Static system prompt — computed once at startup and cached by Anthropic
const STATIC_PITCHING_SYSTEM = `You are an expert baseball pitching coach and biomechanics analyst with 25+ years of experience. You specialize in arm health, injury prevention, and sustainable mechanics for players aged 8-18. Your analysis is benchmarked against 10 elite professional pitchers randomly selected each session from a pool of 20.

Shared mechanical standards: lower half leads, balanced leg lift, stride toward plate, elbow at or above shoulder when cocked, hip-shoulder separation, arm in power zone, glove side tucked, arm decelerates across body, spine angle maintained.

Analyze labeled frames as a complete motion sequence comparing to these standards. For every opportunity name which pitcher demonstrates the correct version. For every strength name which pitcher this most resembles.

CRITICAL RULE: Your JSON response must NEVER contain specific player names. Describe mechanics using phrases like professional-grade arm path, elite-level delivery, consistent with high-velocity professional standards. The benchmark list informs your analysis quality only — never appear as named references in your JSON output.

GRADING SCALE — apply strictly against professional MLB standards. Do not grade on effort, age, or potential:
A+ / A / A-: Professional or near-professional execution. Mechanics match MLB benchmarks on nearly every key checkpoint. Extremely rare outside professional baseball.
B+ / B / B-: College or advanced competitive amateur level. Strong fundamentals with only minor deviations from professional standards. Uncommon in players under 16.
C+ / C / C-: High school varsity level. Fundamentals mostly present but with clear, correctable flaws visible across multiple frames.
D+ / D / D-: Recreational or beginner level. Significant deviations from proper mechanics across several checkpoints. Typical for youth players aged 8-12.
F: Poor mechanics with multiple critical flaws that risk injury or severely limit performance.
Be honest — most youth players aged 8-12 should score D to C range. Grading inflation helps no one. Assign the grade the mechanics earn, not the grade that feels encouraging.

DRILL LIBRARY — for each opportunity use the exact drill name in "drillName":
${buildDrillList("pitching")}

MOVEMENT AGE — if the player's chronological age is provided, estimate movementAge (integer): the developmental age their mechanics most closely reflect. Base this on mechanical maturity, sequencing sophistication, and consistency relative to typical athlete development curves — not on effort or athleticism. A 12-year-old with mechanics typical of a 14-year-old gets movementAge 14. A 15-year-old with mechanics typical of a 12-year-old gets movementAge 12. Omit this field entirely if no chronological age is provided.

Respond ONLY with valid JSON (no markdown, no preamble):
{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark pitchers this resembles.","armHealthRisk":"LOW","armHealthNote":"1-2 sentences on arm safety.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which pitcher and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 8","detail":"Thorough explanation with benchmark comparison.","mlbExample":"Specific benchmark pitcher who does this correctly and what it looks like.","drill":"1-2 sentence player-specific coaching note for this opportunity.","drillName":"Exact drill name from the library above."}],"coachNote":"2-3 sentence honest encouraging close.","movementAge":14,"qualityWarnings":["include only if a frame is clearly blurry, too dark, or obscures key mechanics — otherwise omit this field"]}
armHealthRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;

function buildPitcherSection(pitchers) {
  return "Benchmark pitchers for this session (randomly selected from a pool of 20):\n\n" +
    pitchers.map((p, i) => `${i+1}. ${p.name.toUpperCase()} — ${p.note}`).join("\n");
}

// ── Batter benchmark data ─────────────────────────────────────────────────────

function selectBatters() {
  const classic = [...CLASSIC_BATTERS].sort(() => Math.random() - 0.5).slice(0, 5);
  const current = [...CURRENT_BATTERS].sort(() => Math.random() - 0.5).slice(0, 5);
  return [...classic, ...current].sort(() => Math.random() - 0.5);
}

// Static system prompt — computed once at startup and cached by Anthropic
const STATIC_BATTING_SYSTEM = `You are an expert baseball hitting coach and biomechanics analyst with 25+ years of experience. Your analysis is benchmarked against 10 elite professional hitters randomly selected each session from a pool of 20.

Shared mechanical standards: balanced athletic stance, controlled load and trigger, stride toward pitcher, front heel plant triggers hip rotation, hips fire before hands, hands stay inside the ball, barrel stays in the zone, extension through contact, complete follow-through with balance.

CRITICAL RULE: Your JSON response must NEVER contain specific player names. Use phrases like professional-grade hip rotation, elite-level barrel path, consistent with top professional contact mechanics. The benchmark list informs your analysis quality only — never appear as named references in your JSON output.

GRADING SCALE — apply strictly against professional MLB standards. Do not grade on effort, age, or potential:
A+ / A / A-: Professional or near-professional execution. Mechanics match MLB benchmarks on nearly every key checkpoint. Extremely rare outside professional baseball.
B+ / B / B-: College or advanced competitive amateur level. Strong fundamentals with only minor deviations from professional standards. Uncommon in players under 16.
C+ / C / C-: High school varsity level. Fundamentals mostly present but with clear, correctable flaws visible across multiple frames.
D+ / D / D-: Recreational or beginner level. Significant deviations from proper mechanics across several checkpoints. Typical for youth players aged 8-12.
F: Poor mechanics with multiple critical flaws that risk injury or severely limit performance.
Be honest — most youth players aged 8-12 should score D to C range. Grading inflation helps no one. Assign the grade the mechanics earn, not the grade that feels encouraging.

DRILL LIBRARY — for each opportunity use the exact drill name in "drillName":
${buildDrillList("batting")}

MOVEMENT AGE — if the player's chronological age is provided, estimate movementAge (integer): the developmental age their mechanics most closely reflect. Base this on mechanical maturity, sequencing sophistication, and consistency relative to typical athlete development curves — not on effort or athleticism. A 12-year-old with mechanics typical of a 14-year-old gets movementAge 14. A 15-year-old with mechanics typical of a 12-year-old gets movementAge 12. Omit this field entirely if no chronological age is provided.

CONTACT TENDENCY — based on visible swing mechanics, assess the batter's likely ball-flight outcome. Include this block whenever frames show the swing through or near contact. Omit entirely only if footage ends before the swing begins.
headPosition: head stability from load through contact — one of: Locked In / Minor Drift / Significant Movement.
attackAngle: estimated swing plane at contact — one of: Steep Downward / Slightly Down / Level / Slightly Up / Steep Upward.
barrelDirection: where the barrel is aimed at the contact zone — one of: Pull Side / Up the Middle / Opposite Field.
balance: body control through the swing — one of: Excellent / Good / Forward Drift / Backward Drift / Collapsing.
tendency: most likely ball-flight outcome — one of: Ground Ball / Line Drive / Fly Ball / Mixed.
explanation: 1-2 sentences connecting these mechanics to the tendency prediction.

Analyze labeled frames as a complete swing sequence. Respond ONLY with valid JSON (no markdown, no preamble):
{"overallGrade":"A","overallSummary":"2-3 sentences","injuryRisk":"LOW","healthNote":"1-2 sentences on wrist/elbow/shoulder stress.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Describe which benchmark profile this most resembles without naming the player."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 7","detail":"Thorough explanation.","mlbExample":"Describe what elite professionals do here without naming the player.","drill":"1-2 sentence player-specific coaching note for this opportunity.","drillName":"Exact drill name from the library above."}],"coachNote":"2-3 sentence honest encouraging close.","movementAge":14,"contactTendency":{"headPosition":"Locked In","attackAngle":"Level","barrelDirection":"Pull Side","balance":"Good","tendency":"Line Drive","explanation":"1-2 sentences."},"qualityWarnings":["include only if a frame is clearly blurry, too dark, or obscures key mechanics — otherwise omit this field"]}
injuryRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;

function buildBatterSection(batters) {
  return "Benchmark hitters for this session (randomly selected from a pool of 20):\n\n" +
    batters.map((b, i) => `${i+1}. ${b.name.toUpperCase()} — ${b.note}`).join("\n");
}

function extractJSON(raw) {
  let s = raw.replace(/` + "```" + `json|` + "```" + `/g, "").trim();
  const start = s.indexOf("{"); if (start === -1) throw new Error("No JSON");
  s = s.slice(start);
  const end = s.lastIndexOf("}"); if (end === -1) throw new Error("JSON truncated");
  s = s.slice(0, end + 1);
  try { return JSON.parse(s); } catch (_) {}
  s = s.replace(/[\x00-\x1F\x7F]/g, m => m === "\n" ? "\\n" : m === "\t" ? "\\t" : "");
  const stack = []; let inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}"); else if (ch === "[") stack.push("]"); else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/,\s*([}\]])/g, "$1");
  while (stack.length) s += stack.pop();
  return JSON.parse(s);
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ status: "ok" }));

app.get("/benchmarks", requireAppSecret, (req, res) => res.json(_b));

app.post("/analyze", requireAppSecret, analyzeLimiter, async (req, res) => {
  const { mode, playerName, frames, userInfo } = req.body;
  const reqKB = Math.round(JSON.stringify(req.body).length / 1024);
  console.log(`[ANALYZE] stage=received frames=${frames?.length} mode=${mode} payload_kb=${reqKB}`);

  if (!frames?.length) return res.status(400).json({ message: "No frames provided" });
  if (frames.length > MAX_FRAMES) return res.status(400).json({ message: "Too many frames" });
  if (!["pitching", "batting"].includes(mode)) return res.status(400).json({ message: "Invalid mode" });

  const safeName = sanitizePlayerName(playerName);

  const selectedPitchers = mode === "pitching" ? selectPitchers() : null;
  const selectedBatters  = mode === "batting"  ? selectBatters()  : null;

  // _benchmarks uses cohortLabels only — player names never leave the server
  const benchmarkNames = mode === "pitching"
    ? selectedPitchers.map(p => p.cohortLabel).join(" · ")
    : selectedBatters.map(b => b.cohortLabel).join(" · ");

  // Prompt caching: static block is cached by Anthropic after first request;
  // dynamic block (randomized player list) is small and changes each session.
  const systemBlocks = [
    { type: "text", text: mode === "pitching" ? STATIC_PITCHING_SYSTEM : STATIC_BATTING_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: mode === "pitching" ? buildPitcherSection(selectedPitchers) : buildBatterSection(selectedBatters) },
  ];

  const content = frames.map(f => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } }));
  const name = safeName ? `${mode === "pitching" ? "Pitcher" : "Batter"}: ${safeName}. ` : "";
  const seq  = frames.map((f, i) => `Frame ${i+1}: ${f.label}`).join(" | ");
  const hasRear  = frames.some(f => f.label && f.label.startsWith("Rear –"));
  const isDualCamera = frames.some(f => f.label && f.label.startsWith("Side –"));
  const dualNote = isDualCamera
    ? hasRear
      ? " Frames are provided from THREE camera angles (Side, Front, and Rear views). Use all three perspectives for a full 3D mechanical analysis — side view shows stride and arm path, front view reveals swing plane and alignment, rear view shows hip rotation, spine angle, and follow-through depth."
      : " Frames are provided from TWO camera angles (Side view and Front view). Use both perspectives for a comprehensive 3D mechanical analysis — the side view shows stride, hip rotation, and arm path; the front view reveals swing plane, hip alignment, and hand path."
    : "";
  const ageNote = userInfo?.age ? ` Player chronological age: ${parseInt(userInfo.age)}.` : '';
  content.push({ type: "text", text: `${name}${frames.length} frames: ${seq}. Analyze all frames and return full JSON breakdown.${dualNote}${ageNote}` });

  try {
    console.log(`[ANALYZE] stage=claude_start model=claude-sonnet-4-6 images=${frames.length}`);
    const message  = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: systemBlocks, messages: [{ role: "user", content }] });
    const raw      = message.content.map(b => b.text || "").join("").trim();
    console.log(`[ANALYZE] stage=claude_done stop_reason=${message.stop_reason} raw_chars=${raw.length}`);
    let analysis   = extractJSON(raw);
    console.log(`[ANALYZE] stage=json_parsed grade=${analysis.overallGrade}`);
    analysis      = injectDrillData(analysis, mode);
    analysis._benchmarks = benchmarkNames;
    analysis._reportId   = crypto.randomUUID();
    res.json({ analysis });
  } catch (err) {
    console.error(`[ANALYZE] stage=error type=${err.constructor?.name} status=${err.status} message=${err.message}`);
    res.status(500).json({ message: err.message || "Analysis failed" });
  }
});

app.post("/send-results", requireAppSecret, emailLimiter, async (req, res) => {
  const { userEmail, userName, playerName, mode, analysis: d, benchmarks, timestamp } = req.body;
  if (!userEmail || !d) return res.status(400).json({ message: "Missing fields" });
  if (!EMAIL_REGEX.test(userEmail)) return res.status(400).json({ message: "Invalid email" });
  if (!["pitching", "batting"].includes(mode)) return res.status(400).json({ message: "Invalid mode" });

  const safeUserEmail  = escapeHtml(userEmail);
  const safeUserName   = escapeHtml(userName);
  const safePlayerName = escapeHtml(playerName);

  const modeLabel = mode === "pitching" ? "Pitching" : "Batting";
  const risk = (d.armHealthRisk || d.injuryRisk || "").toUpperCase();

  const drillHtml = (o) => {
    if (o.drillData) {
      return `<div style="background:#f0f4f8;border:1px solid #ccc;border-radius:4px;padding:10px;margin-top:8px">
        <strong>${escapeHtml(o.drillData.name)}</strong>
        <p style="margin:6px 0;font-size:13px">${escapeHtml(o.drillData.description)}</p>
        ${o.drill ? `<p style="margin:4px 0;font-size:12px;color:#555;font-style:italic">${escapeHtml(o.drill)}</p>` : ""}
        <p style="margin:4px 0;font-size:11px;color:#777;font-style:italic">Search: "${escapeHtml(o.drillData.searchQuery)}"</p>
      </div>`;
    }
    return `<p style="color:#1a3a6a"><strong>Drill:</strong> ${escapeHtml(o.drill)}</p>`;
  };

  const oppsHtml = (d.opportunities || []).map(o => `<div style="background:#fff8f5;border-left:4px solid #e74c3c;border-radius:6px;padding:14px;margin-bottom:12px"><strong>${escapeHtml(o.priority)}: ${escapeHtml(o.title)}</strong>${o.frameRef ? ` (${escapeHtml(o.frameRef)})` : ""}<p style="margin:8px 0">${escapeHtml(o.detail)}</p>${o.mlbExample ? `<p style="color:#8a6010"><strong>Elite Reference:</strong> ${escapeHtml(o.mlbExample)}</p>` : ""}${drillHtml(o)}</div>`).join("");
  const strsHtml = (d.strengths || []).map(s => `<div style="background:#efffee;border-left:4px solid #2ecc71;border-radius:6px;padding:14px;margin-bottom:10px"><strong>✓ ${escapeHtml(s.title)}</strong><p style="margin:6px 0">${escapeHtml(s.detail)}</p>${s.mlbMatch ? `<p style="color:#2a6a40;font-style:italic">${escapeHtml(s.mlbMatch)}</p>` : ""}</div>`).join("");
  const tendencyHtml = (mode === "batting" && d.contactTendency) ? (() => {
    const ct = d.contactTendency;
    const tColor = { "Ground Ball": "#c8651a", "Line Drive": "#2ecc71", "Fly Ball": "#3a8ce8", "Mixed": "#b8943a" }[ct.tendency] || "#b8943a";
    return `<div style="background:#f8f4ee;border:1px solid ${tColor};border-top:3px solid ${tColor};border-radius:8px;padding:14px;margin:16px 0">
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Contact Tendency</div>
      <div style="display:inline-block;padding:4px 14px;border:1px solid ${tColor};border-radius:6px;font-size:18px;font-weight:bold;color:${tColor};margin-bottom:10px">${escapeHtml(ct.tendency)}</div>
      <table style="font-size:12px;border-collapse:collapse;width:100%">
        <tr><td style="color:#888;padding:2px 0">Head Position</td><td style="font-weight:600;text-align:right">${escapeHtml(ct.headPosition)}</td></tr>
        <tr><td style="color:#888;padding:2px 0">Attack Angle</td><td style="font-weight:600;text-align:right">${escapeHtml(ct.attackAngle)}</td></tr>
        <tr><td style="color:#888;padding:2px 0">Barrel Direction</td><td style="font-weight:600;text-align:right">${escapeHtml(ct.barrelDirection)}</td></tr>
        <tr><td style="color:#888;padding:2px 0">Balance</td><td style="font-weight:600;text-align:right">${escapeHtml(ct.balance)}</td></tr>
      </table>
      ${ct.explanation ? `<p style="margin:10px 0 0;font-size:12px;color:#555;font-style:italic">${escapeHtml(ct.explanation)}</p>` : ""}
    </div>`;
  })() : "";

  const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;background:#fff"><div style="background:#07090f;padding:20px;border-bottom:3px solid #b8943a"><h1 style="color:#fff;margin:0">⚾ Baseball Mechanics</h1></div><div style="padding:20px"><p>Hi ${safeUserName},</p><p>Your <strong>${modeLabel} Analysis</strong> for <strong>${safePlayerName || safeUserName}</strong> is complete.</p><div style="background:#f0f8f0;border:2px solid #2ecc71;border-radius:8px;padding:16px;margin:16px 0"><h2 style="margin:0 0 8px">Grade: ${escapeHtml(d.overallGrade)} | ${mode === "pitching" ? "Arm Health" : "Injury"} Risk: ${escapeHtml(risk)}</h2><p>${escapeHtml(d.overallSummary)}</p></div><div style="background:#fdf8e8;border:1px solid #c8a030;border-radius:6px;padding:10px;margin-bottom:16px;font-size:12px"><strong>Benchmarked against:</strong> ${escapeHtml(benchmarks)}</div>${tendencyHtml}<h3>Opportunities</h3>${oppsHtml}<h3>Strengths</h3>${strsHtml}${d.coachNote ? `<div style="background:#fdf8e8;border-top:3px solid #c8a030;padding:14px;margin-top:16px"><em>"${escapeHtml(d.coachNote)}"</em></div>` : ""}<p style="color:#999;font-size:11px;margin-top:20px">Baseball Mechanics App · ${new Date(timestamp || Date.now()).toLocaleDateString()}</p></div></body></html>`;
  try {
    await mailer.sendMail({ from: '"Baseball Mechanics App" <fixnetworkpc@gmail.com>', to: userEmail, subject: `⚾ Your ${modeLabel} Analysis — ${safePlayerName || safeUserName}`, html });
    if (req.body.tier && req.body.tier !== "free") {
      await mailer.sendMail({ from: '"Baseball Mechanics App" <fixnetworkpc@gmail.com>', to: OWNER_EMAIL, subject: `[Paid User] ${modeLabel} Analysis — ${safeUserEmail}`, text: `Paid user completed analysis.\nUser: ${userName}\nEmail: ${userEmail}\nPlayer: ${playerName}\nDate: ${new Date().toISOString()}` });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Email failed: " + err.message }); }
});

app.post("/report-error", requireAppSecret, errorLimiter, async (req, res) => {
  const { timestamp, appVersion, platform, osVersion, context, errorMessage, errorStack, userEmail, userName } = req.body;
  const safeMessage = String(errorMessage || "").slice(0, 500);
  const safeStack   = String(errorStack   || "").slice(0, 3000);
  const text = `BASEBALL MECHANICS ERROR\n\nTime: ${timestamp}\nVersion: ${appVersion}\nPlatform: ${platform} ${osVersion}\nContext: ${context}\nUser: ${userName} (${userEmail})\n\nError: ${safeMessage}\n\nStack:\n${safeStack}`;
  try {
    await mailer.sendMail({ from: '"Baseball Mechanics Errors" <fixnetworkpc@gmail.com>', to: OWNER_EMAIL, subject: `App Error: ${safeMessage.substring(0, 60)}`, text });
    res.json({ received: true });
  } catch (err) { res.status(500).json({ message: "Error report failed" }); }
});

// ── Feedback forms ────────────────────────────────────────────────────────────

function buildFeedbackFormHtml(type, reportId) {
  const isCoaching = type === "coaching";
  const title = isCoaching ? "Request Additional Coaching Tips" : "Report an App Issue";
  const coachingFields = isCoaching ? `
    <div class="field">
      <label>Player Name</label>
      <input type="text" name="playerName" maxlength="80">
    </div>
    <div class="field">
      <label>Pitching or Batting?</label>
      <select name="analysisMode">
        <option value="">Select...</option>
        <option value="pitching">Pitching</option>
        <option value="batting">Batting</option>
      </select>
    </div>
    <div class="field">
      <label>Your Question <span class="req">*</span></label>
      <textarea name="question" rows="4" required placeholder="e.g. My son still drops his elbow. Any drills?"></textarea>
    </div>
    <div class="field">
      <label>Additional Notes</label>
      <textarea name="notes" rows="3" placeholder="Any other context..."></textarea>
    </div>` : `
    <div class="field">
      <label>Device Type</label>
      <input type="text" name="deviceType" maxlength="80" placeholder="e.g. iPhone 14, Samsung Galaxy S22">
    </div>
    <div class="field">
      <label>App Version</label>
      <input type="text" name="appVersion" maxlength="20" placeholder="e.g. 1.0.0">
    </div>
    <div class="field">
      <label>Issue Description <span class="req">*</span></label>
      <textarea name="description" rows="5" required placeholder="Describe the issue..."></textarea>
    </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Baseball Mechanics</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#07090f;color:#c8d8f0;min-height:100vh}
header{background:#07090f;border-bottom:3px solid #b8943a;padding:16px 20px}
header h1{color:#fff;font-size:20px;margin-bottom:4px}
header h2{color:#b8943a;font-size:14px;font-weight:400}
.container{max-width:600px;margin:0 auto;padding:24px 20px}
.field{margin-bottom:18px}
label{display:block;font-size:13px;color:#8aaac8;margin-bottom:6px;font-weight:500}
.req{color:#e74c3c}
input,select,textarea{width:100%;background:#0d1420;border:1px solid #1a2840;border-radius:6px;color:#c8d8f0;padding:10px 12px;font-size:15px;font-family:inherit}
textarea{resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:#b8943a}
.honeypot{display:none}
button{width:100%;background:#b8943a;color:#07090f;border:none;border-radius:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}
button:hover{background:#d4a840}
.rid{font-size:12px;color:#4a6080;margin-bottom:20px;background:#0a1020;padding:10px;border-radius:6px;border:1px solid #1a2840}
.footer{text-align:center;padding:20px;font-size:12px;color:#4a6080}
</style>
</head>
<body>
<header><h1>⚾ Baseball Mechanics</h1><h2>${escapeHtml(title)}</h2></header>
<div class="container">
${reportId ? `<div class="rid">Analysis ID: ${escapeHtml(reportId)}</div>` : ""}
<form method="POST" action="/feedback">
  <input type="hidden" name="type" value="${escapeHtml(type)}">
  <input type="hidden" name="reportId" value="${escapeHtml(reportId)}">
  <div class="honeypot"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
  <div class="field">
    <label>Your Email <span class="req">*</span></label>
    <input type="email" name="email" required maxlength="120">
  </div>
  ${coachingFields}
  <button type="submit">Submit</button>
</form>
</div>
<div class="footer">Baseball Mechanics · Support: baseballmsupport@gmail.com</div>
</body></html>`;
}

function buildThankYouHtml(type) {
  const msg = type === "bug"
    ? "Your bug report has been submitted. We'll look into it and follow up if needed."
    : "Your coaching question has been submitted. We'll review it and get back to you.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thank You — Baseball Mechanics</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#07090f;color:#c8d8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:440px;background:#0d1420;border:1px solid #1a2840;border-top:3px solid #2ecc71;border-radius:12px;padding:32px;text-align:center}
h2{color:#2ecc71;margin-bottom:12px;font-size:22px}
p{color:#8aaac8;line-height:1.6;margin-bottom:16px}
.foot{font-size:12px;color:#4a6080;margin-top:8px}
</style>
</head>
<body>
<div class="card">
  <h2>✓ Submitted</h2>
  <p>${escapeHtml(msg)}</p>
  <div class="foot">⚾ Baseball Mechanics · baseballmsupport@gmail.com</div>
</div>
</body></html>`;
}

app.get("/feedback", (req, res) => {
  const type     = req.query.type === "bug" ? "bug" : "coaching";
  const reportId = String(req.query.id || "").slice(0, 40);
  res.setHeader("Content-Type", "text/html");
  res.send(buildFeedbackFormHtml(type, reportId));
});

app.post("/feedback", feedbackLimiter, async (req, res) => {
  const { type, reportId, email, playerName, analysisMode, question, notes, deviceType, appVersion, description, website } = req.body;
  res.setHeader("Content-Type", "text/html");
  if (website) return res.send(buildThankYouHtml(type));
  if (!email || !EMAIL_REGEX.test(email)) return res.status(400).send("<p>Invalid email. Please go back and try again.</p>");

  const isCoaching = type !== "bug";
  const subject = isCoaching
    ? `[Coaching Question] ${email} — Analysis ${reportId || "N/A"}`
    : `[Bug Report] ${email} — Analysis ${reportId || "N/A"}`;
  const text = isCoaching
    ? `COACHING QUESTION\n\nFrom: ${email}\nPlayer: ${playerName || "N/A"}\nMode: ${analysisMode || "N/A"}\nAnalysis ID: ${reportId || "N/A"}\nTimestamp: ${new Date().toISOString()}\n\nQuestion:\n${question || "N/A"}\n\nAdditional Notes:\n${notes || "None"}`
    : `BUG REPORT\n\nFrom: ${email}\nDevice: ${deviceType || "N/A"}\nApp Version: ${appVersion || "N/A"}\nAnalysis ID: ${reportId || "N/A"}\nTimestamp: ${new Date().toISOString()}\n\nDescription:\n${description || "N/A"}`;

  try {
    await mailer.sendMail({ from: '"Baseball Mechanics Feedback" <fixnetworkpc@gmail.com>', to: OWNER_EMAIL, replyTo: email, subject, text });
  } catch (err) {
    console.error("Feedback email error:", err.message);
  }
  res.send(buildThankYouHtml(type));
});

app.listen(port, () => console.log(`Baseball Mechanics API running on port ${port}`));
