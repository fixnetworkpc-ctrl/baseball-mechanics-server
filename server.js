require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");

const app = express();
const port = process.env.PORT || 3001;

// ── Security constants ────────────────────────────────────────────────────────
const APP_SECRET = process.env.APP_SECRET;
const MAX_FRAMES = 12;
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

const analyzeLimiter = rateLimit({ windowMs: 15*60*1000, max: 30,  message: { message: "Too many requests." } });
const emailLimiter   = rateLimit({ windowMs: 60*60*1000, max: 20,  message: { message: "Too many requests." } });
const errorLimiter   = rateLimit({ windowMs: 60*60*1000, max: 50,  message: { message: "Too many requests." } });

// ── Drill library ─────────────────────────────────────────────────────────────

const DRILL_LIBRARY = {
  pitching: [
    {
      name: "Balance Point Pause Drill",
      mechanic: "balance, leg lift control",
      description: "At the top of the leg lift, hold the balance point for a 3-count before delivering. Builds proprioception and controlled load into the stride. Perform 15 reps in a bullpen session.",
      searchQuery: "balance point pause drill baseball pitching mechanics",
    },
    {
      name: "Hip-Shoulder Separation Band Drill",
      mechanic: "hip-shoulder separation",
      description: "Place a resistance band around the torso at shoulder level. Fire the hips through delivery while the band resists the upper body, forcing the lower half to lead. Perform 3 sets of 10.",
      searchQuery: "hip shoulder separation pitching resistance band drill baseball",
    },
    {
      name: "Towel Drill",
      mechanic: "arm path, arm extension",
      description: "Hold a small towel in the throwing hand and deliver at full speed toward a target 10-12 feet away, snapping the towel at the target point. Forces a proper arm path and full extension through the release zone.",
      searchQuery: "towel drill baseball pitching arm path extension",
    },
    {
      name: "Knee Drill",
      mechanic: "hip rotation, arm path isolation",
      description: "Kneel on the throwing-side knee and throw full effort to a partner. Eliminates lower-half variables so the pitcher can isolate hip rotation sequencing and arm path without stride mechanics interfering.",
      searchQuery: "kneeling delivery drill baseball pitching hip rotation arm path",
    },
    {
      name: "Wall Arm Path Drill",
      mechanic: "arm path, power zone, elbow height",
      description: "Stand with the glove-side shoulder 6-8 inches from a wall. Execute the full arm circle — if the arm contacts the wall, it has broken outside the power zone. Demands an on-line, elbow-up arm path.",
      searchQuery: "wall drill baseball pitching arm path power zone elbow",
    },
    {
      name: "Stride Direction Tape Drill",
      mechanic: "stride direction, alignment toward plate",
      description: "Place a strip of tape from the rubber directly toward home plate. The stride foot should land on or just inside the tape line. Instant visual feedback on whether the pitcher strides open, closed, or on-line.",
      searchQuery: "stride direction tape drill baseball pitching alignment",
    },
    {
      name: "Glove Tuck and Pull Drill",
      mechanic: "glove-side control, front-side stability",
      description: "In slow motion in front of a mirror, practice driving the glove toward the hip pocket as the throwing arm accelerates. Build the pattern in isolation until automatic, then integrate into full bullpen work.",
      searchQuery: "glove tuck pull drill baseball pitching front side control",
    },
    {
      name: "Cross-Body Follow-Through Drill",
      mechanic: "deceleration, arm path across body",
      description: "After each pitch, deliberately drive the throwing arm across the torso and finish with the hand outside the opposite hip. Trains proper deceleration mechanics and reduces shoulder and elbow stress.",
      searchQuery: "cross body follow through deceleration drill baseball pitching",
    },
    {
      name: "Long Toss Progression",
      mechanic: "arm strength, extension, carry",
      description: "Begin at 60 feet and extend distance to 90, 120, and 150+ feet on successive throws. Return trip compresses back to 60 feet. Builds posterior shoulder strength and reinforces extension through the release point.",
      searchQuery: "long toss progression program baseball pitching arm strength",
    },
    {
      name: "Drive Leg Push-Off Drill",
      mechanic: "lower half drive, back leg extension",
      description: "Place a foam roller or low hurdle behind the pivot foot. The drive leg must push up and over the barrier to complete the pitch. Teaches aggressive back-leg extension and proper weight transfer toward the plate.",
      searchQuery: "drive leg push off drill baseball pitching lower half power",
    },
    {
      name: "Plyo Ball Reverse Throw",
      mechanic: "deceleration, arm health, posterior chain",
      description: "Using a plyo ball and a padded wall, perform reverse throws — starting from the follow-through position and throwing backward into the wall. Strengthens posterior shoulder and trains the muscles responsible for deceleration.",
      searchQuery: "plyo ball reverse throw deceleration baseball pitching arm health",
    },
    {
      name: "Mirror Mechanics Drill",
      mechanic: "mechanics consistency, visual self-correction",
      description: "Perform the full delivery — leg lift, stride, arm action, and follow-through — in front of a full-length mirror. Watch for deviations in balance, arm path, and finish position. Repeat 15 reps per session.",
      searchQuery: "mirror drill baseball pitching mechanics consistency self correction",
    },
    {
      name: "Flat Ground Mechanics Work",
      mechanic: "general mechanics, command, repeatability",
      description: "Throw 30-50 pitches from flat ground at 70-80% intensity, focusing entirely on mechanical execution rather than velocity. Valuable for grooving movement patterns without mound fatigue.",
      searchQuery: "flat ground work baseball pitching mechanics drill command",
    },
    {
      name: "Spin Ball Hip Fire Drill",
      mechanic: "hip-shoulder separation, rotational sequencing",
      description: "Hold a spin ball at chest height with both hands. Rotate the hips aggressively while keeping the ball and hands stationary as long as possible. Feel the torso stretch and release late. Isolates the hip-to-shoulder sequence.",
      searchQuery: "hip fire rotational sequencing spin ball baseball pitching",
    },
    {
      name: "Pause at K-Position Drill",
      mechanic: "arm cocking, elbow at or above shoulder",
      description: "At the K-position (arm cocked, elbow at shoulder height), pause for a 2-count and verify elbow height before delivering. Adding a light wrist weight increases proprioceptive feedback at that joint angle.",
      searchQuery: "K position arm cocking elbow shoulder baseball pitching drill",
    },
    {
      name: "Rocker Step Tempo Drill",
      mechanic: "timing, footwork, weight shift rhythm",
      description: "Exaggerate a slow, deliberate rocker step and pause after the weight shifts back before lifting the knee. Rebuilds proper early-delivery timing and prevents rushing that collapses the balance point.",
      searchQuery: "rocker step timing tempo drill baseball pitching footwork",
    },
    {
      name: "High Sock Visual Feedback Drill",
      mechanic: "stride direction, front-side landing",
      description: "Pull socks up high and look down at the stride foot during slow-motion delivery work. The sock line gives clear visual reference for landing position relative to alignment. Use with tape drill for combined feedback.",
      searchQuery: "high sock stride direction feedback baseball pitching visual",
    },
    {
      name: "Short Distance Command Drill",
      mechanic: "release point consistency, command",
      description: "Throw from 40-50 feet to a catcher, hitting a glove target with maximum precision at zero velocity emphasis. Builds release-point muscle memory and reinforces repeatable arm action through command reps.",
      searchQuery: "short distance command drill baseball pitching release point consistency",
    },
  ],

  batting: [
    {
      name: "Tee Work Hip Rotation Focus",
      mechanic: "hip rotation, swing foundation",
      description: "Set a tee at the normal contact point. Take 20 swings focusing solely on the lower half: load the rear hip, plant the front heel, and fire the hips before the hands move. Hands stay passive until the hips have started turning.",
      searchQuery: "tee work hip rotation baseball hitting drill foundation",
    },
    {
      name: "Front Toss Timing Drill",
      mechanic: "timing, barrel path, contact",
      description: "Coach soft-tosses from 15-20 feet slightly off-center. Focus on tracking the ball from release and driving it up the middle. Builds hand-eye coordination and bat-to-ball timing in a live-repetition setting.",
      searchQuery: "front toss timing drill baseball batting contact",
    },
    {
      name: "Hip Load and Trigger Drill",
      mechanic: "hip load, weight shift trigger",
      description: "From the stance, take an exaggerated hip load into the rear leg and hold for a 2-count before initiating the stride and swing. The extended pause builds proprioception of full hip loading before the trigger fires.",
      searchQuery: "hip load trigger drill baseball batting stance weight shift",
    },
    {
      name: "Heel Plant Hip Fire Drill",
      mechanic: "front heel timing, hip rotation trigger",
      description: "Take slow-motion tee swings focusing entirely on the front heel plant sequence. The heel must drive into the ground before the hands move. No velocity emphasis — this is feel work for the trigger mechanism.",
      searchQuery: "front heel plant hip fire baseball hitting trigger drill",
    },
    {
      name: "Bottom-Hand Extension Drill",
      mechanic: "lead arm extension, follow-through path",
      description: "Remove the top hand from the bat after contact and extend through the ball using only the bottom hand, holding the finish for a 2-count. Develops lead-arm extension and prevents rolling over at contact.",
      searchQuery: "one hand bottom hand extension drill baseball hitting lead arm",
    },
    {
      name: "Top-Hand Barrel Control Drill",
      mechanic: "top hand, barrel path, bat control",
      description: "Swing using only the top hand on the bat. Keep the barrel above the hands through the swing plane and drive it to the contact zone. Builds top-hand strength and barrel awareness for staying on plane.",
      searchQuery: "one hand top hand barrel control drill baseball hitting",
    },
    {
      name: "Inside-Out Tee Drill",
      mechanic: "hands inside the ball, opposite-field contact",
      description: "Place the tee on the inner third of the plate. Keep the hands tight to the body and drive the ball to the opposite field. Eliminates casting the barrel and builds the hands-inside mechanical pattern.",
      searchQuery: "inside out tee drill baseball hitting hands inside the ball",
    },
    {
      name: "High-Low Tee Drill",
      mechanic: "swing plane, pitch-level adjustment",
      description: "Set two tees — one at belt height and one at knee height. Alternate swings between levels while maintaining consistent hip rotation and barrel path at each height. Develops adaptable swing plane.",
      searchQuery: "high low tee drill swing plane baseball hitting pitch level",
    },
    {
      name: "Rear Hip Hinge Load Drill",
      mechanic: "rear hip loading, weight shift",
      description: "Stand with the rear hip touching a wall. As the load begins, the hip moves away from the wall (hinging back and down). If the hip stays against the wall, the hitter is swaying rather than hinging. Wall provides instant feedback.",
      searchQuery: "rear hip hinge load wall drill baseball hitting weight shift",
    },
    {
      name: "Staying Back Off-Speed Drill",
      mechanic: "weight transfer timing, pitch recognition",
      description: "A coach mixes fastballs and off-speed from a machine or front toss. Focus on keeping weight loaded until the ball's trajectory is confirmed. Off-speed pitches are driven to the opposite field.",
      searchQuery: "staying back off speed drill baseball hitting timing weight shift",
    },
    {
      name: "Extension and Finish Drill",
      mechanic: "follow-through, extension through contact",
      description: "After each swing, hold the finish position for a 3-count. Arms should be fully extended, front elbow up, and weight balanced on the front side. Ingrains a complete, powerful follow-through.",
      searchQuery: "extension follow through finish drill baseball hitting",
    },
    {
      name: "Heavy Bag Hip Rotation Drill",
      mechanic: "hip rotation power, rotational core",
      description: "Rotate through the swing and drive both hands into a heavy bag positioned at the contact point. The bag's resistance demands maximum hip rotation and prevents arm-dominant swings from generating power.",
      searchQuery: "heavy bag hip rotation power drill baseball hitting core",
    },
    {
      name: "Mirror Stance and Load Check",
      mechanic: "stance symmetry, load consistency",
      description: "Stand in front of a mirror and perform the full load-and-stride sequence without swinging. Check for symmetry in setup, balance during load, and consistent stride direction. Correct any pre-swing inconsistencies visually.",
      searchQuery: "mirror stance load check drill baseball hitting mechanics",
    },
    {
      name: "Rapid-Fire Front Toss",
      mechanic: "bat speed, reaction time",
      description: "A coach tosses balls in quick succession with minimal rest. The hitter resets stance rapidly and takes full swings on each toss. Trains fast-twitch response, bat speed under fatigue, and mental presence.",
      searchQuery: "rapid fire front toss bat speed drill baseball hitting reaction",
    },
    {
      name: "Overload and Underload Bat Speed",
      mechanic: "bat speed, fast-twitch development",
      description: "Alternate sets of swings with a heavier-than-game bat (overload) and a lighter-than-game bat (underload). The neurological contrast between heavy and light develops explosive bat speed through contrast training.",
      searchQuery: "overload underload bat speed contrast training baseball hitting",
    },
    {
      name: "Hip-Shoulder Separation Band Drill",
      mechanic: "hip-shoulder separation, rotational lag",
      description: "Wrap a resistance band around the shoulders. During each swing, fire the hips fully while the band slows the shoulder turn. Forces awareness of the separation between lower and upper half and builds torque.",
      searchQuery: "hip shoulder separation band drill baseball hitting rotational lag",
    },
    {
      name: "No-Stride Hip Isolation Drill",
      mechanic: "hip rotation, lower-half isolation",
      description: "Start with feet already planted in the launch position — no stride taken. Swing focusing entirely on hip rotation and keeping hands inside the ball. Strips stride variables so the hitter can isolate and feel pure hip fire.",
      searchQuery: "no stride hip isolation drill baseball hitting lower half rotation",
    },
    {
      name: "Contact Point Fence Drill",
      mechanic: "contact point, prevent barrel casting",
      description: "Stand with a fence or wall about one bat-length behind the hitter. Take full swings — if the barrel hits the fence on the backswing, the arc is too wide. Forces a direct, compact path to the ball.",
      searchQuery: "fence drill contact point prevent casting baseball hitting compact",
    },
    {
      name: "Rotational Plyo Ball Wall Work",
      mechanic: "rotational power, core engagement",
      description: "Stand sideways to a solid wall or rebounder. Rotate aggressively and throw a plyo ball into the wall, catching the rebound. Builds rotational core power that transfers directly to bat speed and hip rotation.",
      searchQuery: "rotational plyo ball wall work baseball hitting core power",
    },
    {
      name: "Stride Direction and Length Drill",
      mechanic: "stride mechanics, direction, length consistency",
      description: "Place tape from the back foot directly toward the pitcher. The stride foot should land 6-8 inches inside the tape line. Consistent stride direction creates consistent contact zones and removes lateral variance.",
      searchQuery: "stride direction length drill baseball hitting mechanics consistency",
    },
  ],
};

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
// cohortLabel: shown to users. name + note: used only internally for AI analysis quality.

const CLASSIC_PITCHERS = [
  { name: "Greg Maddux",      cohortLabel: "Arm Health & Longevity Elite",          note: "textbook hip-to-shoulder separation, elbow always in front, glove tucked — 23 seasons minimal arm issues" },
  { name: "Clayton Kershaw",  cohortLabel: "Top 1% Hip-Shoulder Separation",        note: "elite balance point, upper-90s hip-shoulder separation, arm path on-line, deceleration across body" },
  { name: "Justin Verlander", cohortLabel: "Power-Through-Timing Archetype",        note: "controlled rocker step, powerful hip rotation before shoulder, late loose arm swing" },
  { name: "Nolan Ryan",       cohortLabel: "27-Season Durability Blueprint",        note: "27 seasons — maximum hip-shoulder separation, full lower-half drive, tremendous follow-through" },
  { name: "Pedro Martinez",   cohortLabel: "Compact High-Extension Profile",        note: "explosive hip rotation, compact arm path, glove tight to chest, elite extension" },
  { name: "Tom Seaver",       cohortLabel: "Drop-and-Drive Lower Half Prototype",   note: "drop-and-drive lower half, powerful back leg push, spine angle maintained throughout" },
  { name: "Sandy Koufax",     cohortLabel: "Pure Repeatable Arm Path Elite",        note: "pure arm path every pitch, balanced upright posture, full extension, clean follow-through" },
  { name: "Max Scherzer",     cohortLabel: "Power Zone Consistency Archetype",      note: "arm in power zone every pitch, glove side disciplined, follow-through across body" },
  { name: "Logan Webb",       cohortLabel: "Minimal-Waste Repeatability Model",     note: "clean repeatable mechanics praised by scouts, minimal wasted movement, low arm stress per outing" },
  { name: "Mariano Rivera",   cohortLabel: "Most Repeatable Delivery Benchmark",    note: "most repeatable delivery in history — same arm path every single pitch, textbook deceleration" },
];

const CURRENT_PITCHERS = [
  { name: "Shohei Ohtani",    cohortLabel: "100+ MPH Lower Half Mechanics",         note: "elite combination of explosive hip rotation and arm speed — 100+ mph mechanics built on lower half" },
  { name: "Paul Skenes",      cohortLabel: "Elite Lower Half Drive Profile",         note: "powerful lower half drive, elite fastball mechanics, exceptional arm path staying in the power zone" },
  { name: "Tarik Skubal",     cohortLabel: "Compact Arm-Health Repeatability",      note: "compact repeatable delivery, exceptional arm health focus, consistent hip-to-shoulder separation" },
  { name: "Gerrit Cole",      cohortLabel: "Elite Hip-Shoulder Power Profile",       note: "elite hip-shoulder separation, high-spin mechanics, strong balance point and drive leg" },
  { name: "Zack Wheeler",     cohortLabel: "Powerful Stride & Extension Archetype",  note: "powerful stride toward plate, elite extension through release, strong follow-through" },
  { name: "Spencer Strider",  cohortLabel: "Short-Path Explosive Hip Rotation",      note: "short compact arm path, explosive hip rotation, high spin from mechanics not just arm" },
  { name: "Blake Snell",      cohortLabel: "High-Separation Late Arm Entry Model",   note: "dramatic hip-shoulder separation, high leg kick with controlled balance, late arm entry" },
  { name: "Framber Valdez",   cohortLabel: "Consistent Arm Path Drive Elite",        note: "elite sinker mechanics built on consistent arm path and strong lower half drive" },
  { name: "Shane Bieber",     cohortLabel: "Pinpoint Command Mechanics Profile",     note: "pinpoint command mechanics, repeatable release point, efficient hip-to-shoulder sequence" },
  { name: "Chris Sale",       cohortLabel: "Elite Extension Release Zone Model",     note: "elite extension through the release zone, unique arm slot with clean and safe deceleration pattern" },
];

function selectPitchers() {
  const classic = [...CLASSIC_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  const current = [...CURRENT_PITCHERS].sort(() => Math.random() - 0.5).slice(0, 5);
  return [...classic, ...current].sort(() => Math.random() - 0.5);
}

function buildPitchingPrompt(pitchers) {
  const list   = pitchers.map((p, i) => `${i+1}. ${p.name.toUpperCase()} — ${p.note}`).join("\n");
  const drills = buildDrillList("pitching");
  return `You are an expert baseball pitching coach and biomechanics analyst with 25+ years of experience. You specialize in arm health, injury prevention, and sustainable mechanics for players aged 8-18. Your analysis for this session is benchmarked against these 10 elite professional pitchers (randomly selected from a pool of 20):\n\n${list}\n\nShared mechanical standards: lower half leads, balanced leg lift, stride toward plate, elbow at or above shoulder when cocked, hip-shoulder separation, arm in power zone, glove side tucked, arm decelerates across body, spine angle maintained.\n\nAnalyze labeled frames as a complete motion sequence comparing to these standards. For every opportunity name which pitcher demonstrates the correct version. For every strength name which pitcher this most resembles.\n\nCRITICAL RULE: Your JSON response must NEVER contain specific player names. Describe mechanics using phrases like professional-grade arm path, elite-level delivery, consistent with high-velocity professional standards. The benchmark list informs your analysis quality only — never appear as named references in your JSON output.\n\nDRILL LIBRARY — for each opportunity use the exact drill name in "drillName":\n${drills}\n\nRespond ONLY with valid JSON (no markdown, no preamble):\n{"overallGrade":"A","overallSummary":"2-3 sentences mentioning which benchmark pitchers this resembles.","armHealthRisk":"LOW","armHealthNote":"1-2 sentences on arm safety.","strengths":[{"title":"title","detail":"2-4 sentences.","mlbMatch":"Which pitcher and why."}],"opportunities":[{"title":"title","priority":"CRITICAL","frameRef":"Frame 8","detail":"Thorough explanation with benchmark comparison.","mlbExample":"Specific benchmark pitcher who does this correctly and what it looks like.","drill":"1-2 sentence player-specific coaching note for this opportunity.","drillName":"Exact drill name from the library above."}],"coachNote":"2-3 sentence honest encouraging close.","qualityWarnings":["include only if a frame is clearly blurry, too dark, or obscures key mechanics — otherwise omit this field"]}\narmHealthRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.`;
}

// ── Batter benchmark data ─────────────────────────────────────────────────────
// cohortLabel: shown to users. name + note: used only internally for AI analysis quality.

const CLASSIC_BATTERS = [
  { name: "Ted Williams",     cohortLabel: "Most-Studied Hip-to-Shoulder Swing",    note: "most studied swing in history, perfect hip-to-shoulder sequence, bat path stays in the zone longest of any hitter ever analyzed" },
  { name: "Babe Ruth",        cohortLabel: "Legendary Hip Rotation Power Archetype", note: "legendary hip rotation and weight transfer, generated elite power from explosive lower-half drive" },
  { name: "Hank Aaron",       cohortLabel: "Quick-Wrist Compact Path Elite",         note: "exceptional quick wrists and compact path to contact, bat speed generated late through the zone" },
  { name: "Willie Mays",      cohortLabel: "Balanced Athletic Load & Timing Model",  note: "balanced athletic load and explosive hip turn, exceptional timing with consistent barrel path" },
  { name: "Mickey Mantle",    cohortLabel: "Elite Power Lower Half Archetype",       note: "elite switch-hitter mechanics, explosive lower half generated power from both sides equally" },
  { name: "Stan Musial",      cohortLabel: "Perfectly Repeatable Coiled Mechanics",  note: "unusual coiled stance but perfectly repeatable, proved mechanics only need to be consistent not textbook" },
  { name: "Barry Bonds",      cohortLabel: "Most Biomechanically Precise Swing",     note: "most biomechanically precise swing ever studied, elite hip rotation with exceptional barrel control through the zone" },
  { name: "Tony Gwynn",       cohortLabel: "Greatest Contact Mechanics Elite",       note: "greatest contact mechanics in modern baseball, short path to ball with exceptional hands-inside discipline" },
  { name: "Ken Griffey Jr.",  cohortLabel: "Aesthetically Perfect Hip Rotation",     note: "widely considered the most aesthetically perfect swing, effortless hip rotation with elite extension and follow-through" },
  { name: "Lou Gehrig",       cohortLabel: "Consistent Power Contact Archetype",     note: "powerful consistent upper-body mechanics, exceptional hands through the zone with elite weight transfer" },
];

const CURRENT_BATTERS = [
  { name: "Shohei Ohtani",    cohortLabel: "Elite Hip Rotation & Barrel Accuracy",   note: "elite hip rotation and bat speed from exceptional lower half, generates elite power while maintaining barrel accuracy" },
  { name: "Mike Trout",       cohortLabel: "Gold Standard Modern Mechanics",          note: "gold standard modern hitting mechanics, elite barrel control with consistent hip-to-shoulder separation" },
  { name: "Freddie Freeman",  cohortLabel: "Textbook Weight Transfer & Extension",   note: "textbook weight transfer and consistent barrel path, exceptional extension through the zone" },
  { name: "Mookie Betts",     cohortLabel: "Compact Elite Bat-to-Ball Profile",       note: "compact controlled swing with elite bat-to-ball skills, exceptional hip turn from minimal load" },
  { name: "Juan Soto",        cohortLabel: "Elite Hip Load & Plate Discipline",       note: "exceptional hip load and patience-driven contact approach, elite ability to stay back on off-speed pitches" },
  { name: "Yordan Alvarez",   cohortLabel: "Hip-Shoulder Separation Power Elite",    note: "massive power from elite hip-to-shoulder separation, exceptional rear leg drive generating elite exit velocity" },
  { name: "Ronald Acuna Jr.", cohortLabel: "Explosive Quick-Hands Bat Speed",        note: "explosive athleticism with quick hands through the zone, exceptional first-move quickness with elite bat speed" },
  { name: "Corey Seager",     cohortLabel: "Smooth Extension Barrel Path Model",     note: "smooth lefty mechanics with consistent extension, elite hip turn with exceptional barrel path to all fields" },
  { name: "Bobby Witt Jr.",   cohortLabel: "Athletic Lower Half Explosive Profile",  note: "elite bat speed with athletic lower half, emerging as one of the most mechanically explosive young hitters" },
  { name: "Paul Goldschmidt", cohortLabel: "Elite Disciplined Contact Archetype",    note: "veteran-level disciplined mechanics and barrel accuracy, exceptional hands-inside approach with elite contact rate" },
];

function selectBatters() {
  const classic = [...CLASSIC_BATTERS].sort(() => Math.random() - 0.5).slice(0, 5);
  const current = [...CURRENT_BATTERS].sort(() => Math.random() - 0.5).slice(0, 5);
  return [...classic, ...current].sort(() => Math.random() - 0.5);
}

function buildBattingPrompt(batters) {
  const list   = batters.map((b, i) => `${i + 1}. ${b.name.toUpperCase()} — ${b.note}`).join("\n");
  const drills = buildDrillList("batting");
  const intro  = "You are an expert baseball hitting coach and biomechanics analyst with 25+ years of experience. Your analysis is benchmarked against these 10 elite professional hitters randomly selected from a pool of 20:\n\n";
  const stds   = "\n\nShared mechanical standards: balanced athletic stance, controlled load and trigger, stride toward pitcher, front heel plant triggers hip rotation, hips fire before hands, hands stay inside the ball, barrel stays in the zone, extension through contact, complete follow-through with balance.\n\n";
  const rule   = "CRITICAL RULE: Your JSON response must NEVER contain specific player names. Use phrases like professional-grade hip rotation, elite-level barrel path, consistent with top professional contact mechanics. The benchmark list informs your analysis quality only — never appear as named references in your JSON output.\n\n";
  const drillSec = `DRILL LIBRARY — for each opportunity use the exact drill name in "drillName":\n${drills}\n\n`;
  const fmt    = "Analyze labeled frames as a complete swing sequence. Respond ONLY with valid JSON (no markdown, no preamble):\n{\"overallGrade\":\"A\",\"overallSummary\":\"2-3 sentences\",\"injuryRisk\":\"LOW\",\"healthNote\":\"1-2 sentences on wrist/elbow/shoulder stress.\",\"strengths\":[{\"title\":\"title\",\"detail\":\"2-4 sentences.\",\"mlbMatch\":\"Describe which benchmark profile this most resembles without naming the player.\"}],\"opportunities\":[{\"title\":\"title\",\"priority\":\"CRITICAL\",\"frameRef\":\"Frame 7\",\"detail\":\"Thorough explanation.\",\"mlbExample\":\"Describe what elite professionals do here without naming the player.\",\"drill\":\"1-2 sentence player-specific coaching note for this opportunity.\",\"drillName\":\"Exact drill name from the library above.\"}],\"coachNote\":\"2-3 sentence honest encouraging close.\",\"qualityWarnings\":[\"include only if a frame is clearly blurry, too dark, or obscures key mechanics — otherwise omit this field\"]}\ninjuryRisk: LOW MODERATE or HIGH. priority: CRITICAL HIGH MEDIUM or LOW.";
  return intro + list + stds + rule + drillSec + fmt;
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

app.post("/analyze", requireAppSecret, analyzeLimiter, async (req, res) => {
  const { mode, playerName, frames, userInfo } = req.body;
  if (!frames?.length) return res.status(400).json({ message: "No frames provided" });
  if (frames.length > MAX_FRAMES) return res.status(400).json({ message: "Too many frames" });
  if (!["pitching", "batting"].includes(mode)) return res.status(400).json({ message: "Invalid mode" });

  const safeName = sanitizePlayerName(playerName);

  const selectedPitchers = mode === "pitching" ? selectPitchers() : null;
  const selectedBatters  = mode === "batting"  ? selectBatters()  : null;
  const systemPrompt     = mode === "pitching" ? buildPitchingPrompt(selectedPitchers) : buildBattingPrompt(selectedBatters);

  // _benchmarks uses cohortLabels only — player names never leave the server
  const benchmarkNames = mode === "pitching"
    ? selectedPitchers.map(p => p.cohortLabel).join(" · ")
    : selectedBatters.map(b => b.cohortLabel).join(" · ");

  const content = frames.map(f => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } }));
  const name = safeName ? `${mode === "pitching" ? "Pitcher" : "Batter"}: ${safeName}. ` : "";
  const seq  = frames.map((f, i) => `Frame ${i+1}: ${f.label}`).join(" | ");
  content.push({ type: "text", text: `${name}${frames.length} frames: ${seq}. Analyze all frames and return full JSON breakdown.` });

  try {
    const message  = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: systemPrompt, messages: [{ role: "user", content }] });
    const raw      = message.content.map(b => b.text || "").join("").trim();
    let analysis   = extractJSON(raw);
    analysis      = injectDrillData(analysis, mode);
    analysis._benchmarks = benchmarkNames;
    res.json({ analysis });
  } catch (err) {
    console.error("Analysis error:", err.message);
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
  const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;background:#fff"><div style="background:#07090f;padding:20px;border-bottom:3px solid #b8943a"><h1 style="color:#fff;margin:0">⚾ Baseball Mechanics</h1></div><div style="padding:20px"><p>Hi ${safeUserName},</p><p>Your <strong>${modeLabel} Analysis</strong> for <strong>${safePlayerName || safeUserName}</strong> is complete.</p><div style="background:#f0f8f0;border:2px solid #2ecc71;border-radius:8px;padding:16px;margin:16px 0"><h2 style="margin:0 0 8px">Grade: ${escapeHtml(d.overallGrade)} | ${mode === "pitching" ? "Arm Health" : "Injury"} Risk: ${escapeHtml(risk)}</h2><p>${escapeHtml(d.overallSummary)}</p></div><div style="background:#fdf8e8;border:1px solid #c8a030;border-radius:6px;padding:10px;margin-bottom:16px;font-size:12px"><strong>Benchmarked against:</strong> ${escapeHtml(benchmarks)}</div><h3>Opportunities</h3>${oppsHtml}<h3>Strengths</h3>${strsHtml}${d.coachNote ? `<div style="background:#fdf8e8;border-top:3px solid #c8a030;padding:14px;margin-top:16px"><em>"${escapeHtml(d.coachNote)}"</em></div>` : ""}<p style="color:#999;font-size:11px;margin-top:20px">Baseball Mechanics App · ${new Date(timestamp || Date.now()).toLocaleDateString()}</p></div></body></html>`;
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

app.listen(port, () => console.log(`Baseball Mechanics API running on port ${port}`));
