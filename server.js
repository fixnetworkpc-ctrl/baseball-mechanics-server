require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");

const app = express();
const port = process.env.PORT || 3001;

const pitchingClient = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY_PITCHING });
const battingClient = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY_BATTING });

const mailer = nodemailer.createTransport({ service: "gmail", auth: { user: "fixnetworkpc@gmail.com", pass: process.env.GMAIL_APP_PASSWORD } });
const OWNER_EMAIL = "fixnetworkpc@gmail.com";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "60mb" }));
const limiter = rateLimit({ windowMs: 15*60*1000, max: 30, message: { message: "Too many requests." } });

const CLASSIC_PITCHERS = [
  { name: "Greg Maddux", note: "textbook hip-to-shoulder separation, elbow always in front, glove tucked — 23 seasons minimal arm issues" },
  { name: "Clayton Kershaw", note: "elite balance point, upper-90s hip-shoulder separation, arm path on-line, deceleration across body" },
  { name: "Justin Verlander", note: "controlled rocker step, powerful hip rotation before shoulder, late loose arm swing" },
  { name: "Nolan Ryan", note: "27 seasons — maximum hip-shoulder separation, full lower-half drive, tremendous follow-through" },
  { name: "Pedro Martinez", note: "explosive hip rotation, compact arm path, glove tight to chest, elite extension" },
  { name: "Tom Seaver", note: "drop-and-drive lower half, powerful back leg push, spine angle maintained throughout" },
  { name: "Sandy Koufax", note: "pure arm path every pitch, balanced upright posture, full extension, clean follow-through" },
  { name: "Max Scherzer", note: "arm in power zone every pitch, glove side disciplined, follow-through across body" },
  { name: "Logan Webb", note: "clean repeatable mechanics praised by scouts, minimal wasted movement, low arm stress per outing" },
  { name: "Mariano Rivera", note: "most repeatable delivery in history — same arm path every single pitch, textbook deceleration" },
];

const CURRENT_PITCHERS = [
  { name: "Shohei Ohtani", note: "elite combination of explosive hip rotation and arm speed — 100+ mph mechanics built on lower half" },
  { name: "Paul Skenes", note: "powerful lower half drive, elite fastball mechanics, exceptional arm path staying in the power zone" },
  { name: "Tarik Skubal", note: "compact repeatable delivery, exceptional arm health focus, consistent hip-to-shoulder separation" },
  { name: "Gerrit Cole", note: "elite hip-shoulder separation, high-spin mechanics, strong balance point and drive leg" },
  { name: "Zack Wheeler", note: "powerful stride toward plate, elite extension through release, strong follow-through" },
  { name: "Spencer Strider", note: "short compact arm path, explosive hip rotation, high spin from mechanics not just arm" },
  { name: "Blake Snell", note: "dramatic hip-shoulder separation, high leg kick with controlled balance, late arm entry" },
  { name: "Framber Valdez", note: "elite sinker mechanics built on consistent arm path and strong lower half drive" },
  { name: "Shane Bieber", note: "pinpoint command mechanics, repeatable release point, efficient hip-to-shoulder sequence" },
  { name: "Chris Sale", note: "elite extension through the release zone, unique arm slot with clean and safe deceleration pattern" },
];

function selectPitchers() {
  const classic = [...CLASSIC_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  const current = [...CURRENT_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  return [...classic, ...current].sort(() => Math.random() - 0.5);
}

function buildPitchingPrompt(pitchers) {
  const list = pitchers.map((p, i) => `${i+1}. ${p.name.toUpperCase()} — ${p.note}`).join("\n");
  return `You are an expert baseball pitching coach and biomechanics analyst with 25+ years of experience. You specialize in arm health, injury prevention, and sustainable mechanics for players aged 8-18. Your analysis for this session is benchmarked against these 10 MLB pitchers (randomly selected from a pool of 20 elite pitchers):\n\n${list}\n\nShared mechanical standards: lower half leads, balanced leg lift, stride toward plate, elbow at or above shoulder when cocked, hip-shoulder separation, arm in power zone, glove side tucked, arm decelerates across body, spine angle maintained.\n\nAnalyze labeled frames as a complete motion sequence comparing to these standards. For every opportunity name which pitcher demonstrates the correct version. For every strength name which pitcher this most resembles.\n\nRespond ONLY with valid JSON (no markdown, no preamble):\n{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark pitchers this resembles.","armHealthRisk":"LOW","armHealthNote":"1-2 sentences on arm safety.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which pitcher and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 8","detail":"Thorough explanation with benchmark comparison.","mlbExample":"Specific benchmark pitcher who does this correctly and what it looks like.","drill":"Named drill with step-by-step."}],"coachNote":"2-3 sentence honest encouraging close."}\narmHealthRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;
}

const BATTING_PROMPT = `You are an expert baseball hitting coach and biomechanics analyst with 25+ years of experience. Your analysis is benchmarked against: Ted Williams, Mike Trout, Ken Griffey Jr., Tony Gwynn, Hank Aaron, Albert Pujols, George Brett, Barry Bonds, Frank Thomas, Freddie Freeman.\n\nAnalyze labeled frames as a complete swing sequence. For every opportunity name which hitter demonstrates the correct version. For every strength name which hitter this most resembles.\n\nRespond ONLY with valid JSON (no markdown, no preamble):\n{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark hitters this resembles.","injuryRisk":"LOW","healthNote":"1-2 sentences on wrist/elbow/shoulder stress.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which hitter and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 7","detail":"Thorough explanation.","mlbExample":"Specific benchmark hitter who does this correctly.","drill":"Named drill with step-by-step."}],"coachNote":"2-3 sentence honest encouraging close."}\ninjuryRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;

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

app.get("/", (req, res) => res.json({ status: "ok", service: "Baseball Mechanics API" }));

app.post("/analyze", limiter, async (req, res) => {
  const { mode, playerName, frames, userInfo } = req.body;
  if (!frames?.length) return res.status(400).json({ message: "No frames provided" });
  if (!["pitching", "batting"].includes(mode)) return res.status(400).json({ message: "Invalid mode" });

  const client = mode === "pitching" ? pitchingClient : battingClient;
  const selectedPitchers = mode === "pitching" ? selectPitchers() : null;
  const systemPrompt = mode === "pitching" ? buildPitchingPrompt(selectedPitchers) : BATTING_PROMPT;
  const benchmarkNames = mode === "pitching" ? selectedPitchers.map(p => p.name).join(" · ") : "Ted Williams · Mike Trout · Ken Griffey Jr. · Tony Gwynn · Hank Aaron · Albert Pujols · George Brett · Barry Bonds · Frank Thomas · Freddie Freeman";

  const content = frames.map(f => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } }));
  const name = playerName?.trim() ? `${mode === "pitching" ? "Pitcher" : "Batter"}: ${playerName.trim()}. ` : "";
  const seq = frames.map((f, i) => `Frame ${i+1}: ${f.label}`).join(" | ");
  content.push({ type: "text", text: `${name}${frames.length} frames: ${seq}. Analyze all frames and return full JSON breakdown.` });

  try {
    const message = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: systemPrompt, messages: [{ role: "user", content }] });
    const raw = message.content.map(b => b.text || "").join("").trim();
    const analysis = extractJSON(raw);
    analysis._benchmarks = benchmarkNames;
    res.json({ analysis });
  } catch (err) {
    console.error("Analysis error:", err.message);
    res.status(500).json({ message: err.message || "Analysis failed" });
  }
});

app.post("/send-results", async (req, res) => {
  const { userEmail, userName, playerName, mode, analysis: d, benchmarks, timestamp } = req.body;
  if (!userEmail || !d) return res.status(400).json({ message: "Missing fields" });
  const modeLabel = mode === "pitching" ? "Pitching" : "Batting";
  const risk = (d.armHealthRisk || d.injuryRisk || "").toUpperCase();
  const oppsHtml = (d.opportunities || []).map(o => `<div style="background:#fff8f5;border-left:4px solid #e74c3c;border-radius:6px;padding:14px;margin-bottom:12px"><strong>${o.priority}: ${o.title}</strong>${o.frameRef ? ` (${o.frameRef})` : ""}<p style="margin:8px 0">${o.detail}</p>${o.mlbExample ? `<p style="color:#8a6010"><strong>MLB Reference:</strong> ${o.mlbExample}</p>` : ""}<p style="color:#1a3a6a"><strong>Drill:</strong> ${o.drill}</p></div>`).join("");
  const strsHtml = (d.strengths || []).map(s => `<div style="background:#efffee;border-left:4px solid #2ecc71;border-radius:6px;padding:14px;margin-bottom:10px"><strong>✓ ${s.title}</strong><p style="margin:6px 0">${s.detail}</p>${s.mlbMatch ? `<p style="color:#2a6a40;font-style:italic">${s.mlbMatch}</p>` : ""}</div>`).join("");
  const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;background:#fff"><div style="background:#07090f;padding:20px;border-bottom:3px solid #b8943a"><h1 style="color:#fff;margin:0">⚾ Baseball Mechanics</h1></div><div style="padding:20px"><p>Hi ${userName},</p><p>Your <strong>${modeLabel} Analysis</strong> for <strong>${playerName || userName}</strong> is complete.</p><div style="background:#f0f8f0;border:2px solid #2ecc71;border-radius:8px;padding:16px;margin:16px 0"><h2 style="margin:0 0 8px">Grade: ${d.overallGrade} | ${mode === "pitching" ? "Arm Health" : "Injury"} Risk: ${risk}</h2><p>${d.overallSummary}</p></div><div style="background:#fdf8e8;border:1px solid #c8a030;border-radius:6px;padding:10px;margin-bottom:16px;font-size:12px"><strong>Benchmarked against:</strong> ${benchmarks}</div><h3>Opportunities</h3>${oppsHtml}<h3>Strengths</h3>${strsHtml}${d.coachNote ? `<div style="background:#fdf8e8;border-top:3px solid #c8a030;padding:14px;margin-top:16px"><em>"${d.coachNote}"</em></div>` : ""}<p style="color:#999;font-size:11px;margin-top:20px">Baseball Mechanics App · ${new Date(timestamp || Date.now()).toLocaleDateString()}</p></div></body></html>`;
  try {
    await mailer.sendMail({ from: '"Baseball Mechanics App" <fixnetworkpc@gmail.com>', to: userEmail, subject: `⚾ Your ${modeLabel} Analysis — ${playerName || userName}`, html });
    if (req.body.tier && req.body.tier !== "free") {
      await mailer.sendMail({ from: '"Baseball Mechanics App" <fixnetworkpc@gmail.com>', to: OWNER_EMAIL, subject: `[Paid User] ${modeLabel} Analysis — ${userEmail}`, text: `Paid user completed analysis.\nUser: ${userName}\nEmail: ${userEmail}\nPlayer: ${playerName}\nDate: ${new Date().toISOString()}` });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Email failed: " + err.message }); }
});

app.post("/report-error", async (req, res) => {
  const { timestamp, appVersion, platform, osVersion, context, errorMessage, errorStack, userEmail, userName } = req.body;
  const text = `BASEBALL MECHANICS ERROR\n\nTime: ${timestamp}\nVersion: ${appVersion}\nPlatform: ${platform} ${osVersion}\nContext: ${context}\nUser: ${userName} (${userEmail})\n\nError: ${errorMessage}\n\nStack:\n${errorStack}`;
  try {
    await mailer.sendMail({ from: '"Baseball Mechanics Errors" <fixnetworkpc@gmail.com>', to: OWNER_EMAIL, subject: `🚨 App Error: ${(errorMessage || "").substring(0, 60)}`, text });
    res.json({ received: true });
  } catch (err) { res.status(500).json({ message: "Error report failed" }); }
});

app.listen(port, () => console.log(`Baseball Mechanics API running on port ${port}`));