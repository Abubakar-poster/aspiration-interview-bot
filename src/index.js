// src/index.js
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./lib/db");
const anti = require("./lib/antiCheat");
const { QUESTIONS } = require("./lib/questions");

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("❌ Missing TELEGRAM_TOKEN in .env");
  process.exit(1);
}

// --- Admin IDs (multiple allowed via .env) ---
const adminIds = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => id.trim())
  : [];

function isAdmin(userId) {
  return adminIds.includes(String(userId));
}

const bot = new TelegramBot(token, { polling: true });

// --- In-memory sessions ---
const sessions = new Map(); // chatId -> {step, startedAt, lastSentAt, challengeCode, candidateId}

// --- Help Messages ---
function getAdminHelp() {
  return `
🛠️ *Admin Commands*
/approve <tgId> → Approve candidate
/revoke <tgId> → Revoke candidate
/list → Show all candidates
/report [tgId] → Generate report (all or by ID)
/export → Export data as CSV
/help → Show this message
`;
}

function getCandidateHelp() {
  return `
📋 *Candidate Instructions*
1. Wait for admin approval before starting.
2. Complete *identity verification* with your selfie.
3. Answer each question honestly in *your own words* (text or voice).
4. Avoid malpractice (copy-paste, duplicate answers, very short replies).
5. Your answers will be stored for admin review.

✅ At the end, you’ll see a confirmation message.
/help → Show this message again
`;
}

// --- Helpers ---
async function startInterview(chatId, user) {
  const candidateId = await db.ensureCandidate(user);
  const approved = await db.isApproved(user.id);

  if (!approved) {
    return bot.sendMessage(
      chatId,
      "🚫 You are not approved to take this interview. Please contact the admin."
    );
  }

  const now = Date.now();
  sessions.set(chatId, {
    step: 0,
    startedAt: now,
    lastSentAt: now,
    candidateId,
    challengeCode: null,
  });

  bot.sendMessage(
    chatId,
    `👋 Welcome ${user.first_name || ""}! This interview has 3 sections:\n\n1️⃣ Identity check\n2️⃣ Core questions\n3️⃣ Final confirmation`
  );

  // Step 0: Identity selfie challenge
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  sessions.get(chatId).challengeCode = code;
  await db.logEvent(candidateId, "challenge_issued", { code });

  bot.sendMessage(
    chatId,
    `📸 Identity check:\nPlease send a *CLEAR selfie* holding a paper with the code: *${code}* as the caption.`,
    { parse_mode: "Markdown" }
  );

  // Send candidate instructions
  bot.sendMessage(chatId, getCandidateHelp(), { parse_mode: "Markdown" });
}

async function askNextQuestion(chatId) {
  const s = sessions.get(chatId);
  if (!s) return;
  const step = s.step;

  if (step === 0) return; // waiting for selfie

  if (step - 1 >= QUESTIONS.length) {
    bot.sendMessage(
      chatId,
      "✅ Interview completed. Thank you! You will be contacted soon."
    );
    await db.finalizeInterview(s.candidateId);
    sessions.delete(chatId);
    return;
  }

  const q = QUESTIONS[step - 1];
  s.lastSentAt = Date.now();
  await db.logEvent(s.candidateId, "question_sent", { idx: step - 1, text: q });
  bot.sendMessage(chatId, `❓ Question ${step}: ${q}`);
}

// --- Commands ---
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  if (isAdmin(user.id)) {
    await bot.sendMessage(chatId, "👋 Hello Admin!", { parse_mode: "Markdown" });
    return bot.sendMessage(chatId, getAdminHelp(), { parse_mode: "Markdown" });
  }

  await startInterview(chatId, user);
});

// NEW: /help for both admins and candidates
bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  if (isAdmin(user.id)) {
    bot.sendMessage(chatId, getAdminHelp(), { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(chatId, getCandidateHelp(), { parse_mode: "Markdown" });
  }
});

bot.onText(/^\/report(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const candidateId = match && match[1] ? Number(match[1]) : null;
  const text = await db.generateReport(candidateId);
  bot.sendMessage(msg.chat.id, "📄 Report:\n" + text.slice(0, 3500));
});

bot.onText(/^\/export$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const csvPath = await db.exportCSV();
  bot.sendDocument(msg.chat.id, csvPath);
});

// --- Approval System ---
bot.onText(/^\/approve (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tgId = parseInt(match[1], 10);
  await db.approveCandidate(tgId);
  bot.sendMessage(msg.chat.id, `✅ Approved candidate with Telegram ID ${tgId}`);
});

bot.onText(/^\/revoke (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const tgId = parseInt(match[1], 10);
  await db.revokeCandidate(tgId);
  bot.sendMessage(msg.chat.id, `❌ Revoked candidate with Telegram ID ${tgId}`);
});

bot.onText(/^\/list$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const report = await db.generateReport();
  bot.sendMessage(msg.chat.id, "📋 Candidate List:\n\n" + report.slice(0, 3500));
});

// --- Handlers ---
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions.get(chatId);
  if (!s) return;

  if (s.step !== 0) return; // ignore after selfie step

  const caption = (msg.caption || "").trim();
  if (!caption.includes(s.challengeCode)) {
    await db.flag(s.candidateId, "selfie_code_mismatch", 2, {
      expected: s.challengeCode,
      got: caption,
    });
    await bot.sendMessage(
      chatId,
      "⚠️ The code in your caption does not match. Please resend the selfie with the correct code."
    );
    return;
  }

  const photos = msg.photo.sort((a, b) => b.file_size - a.file_size);
  const biggest = photos[0];
  if (biggest.file_size < 30_000) {
    await db.flag(s.candidateId, "low_quality_selfie", 1, {
      size: biggest.file_size,
    });
    await bot.sendMessage(
      chatId,
      "⚠️ Low quality image detected. Consider retaking for clarity."
    );
  }

  await db.logEvent(s.candidateId, "selfie_passed", { file_id: biggest.file_id });
  s.step = 1;
  askNextQuestion(chatId);
});

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions.get(chatId);
  if (!s || s.step <= 0) return;

  const idx = s.step - 1;
  const duration = msg.voice.duration || 0;
  const answerMeta = { type: "voice", duration };

  if (duration < 2) {
    await db.flag(s.candidateId, "too_short_voice", 1, { duration });
    bot.sendMessage(chatId, "⚠️ Voice answer is too short; please elaborate.");
  }

  await db.storeAnswer(s.candidateId, idx, "[voice message]", answerMeta);
  s.step += 1;
  askNextQuestion(chatId);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions.get(chatId);
  if (!s) return;

  if (msg.text && msg.text.startsWith("/")) return;
  if (msg.photo || msg.voice || msg.video) return;
  if (s.step === 0) return; // waiting for selfie

  const idx = s.step - 1;
  const qSentAt = s.lastSentAt || Date.now();
  const now = Date.now();
  const answerText = (msg.text || "").trim();

  const signals = [];
  if (anti.tooFast(qSentAt, now, answerText)) signals.push("too_fast");
  if (anti.copyPasteLikely(qSentAt, now, answerText)) signals.push("copy_paste_likely");

  const similarityHit = await anti.isSimilarToExisting(db, answerText);
  if (similarityHit.hit) {
    signals.push("duplicate_answer");
    await db.flag(s.candidateId, "duplicate_answer", 2, {
      withCandidateId: similarityHit.candidateId,
      score: similarityHit.score,
    });
  }

  await db.storeAnswer(s.candidateId, idx, answerText, {
    latencyMs: now - qSentAt,
    signals,
  });

  if (signals.length >= 2) {
    bot.sendMessage(
      chatId,
      "⚠️ Your last answer raised multiple red flags. Please answer in your own words."
    );
  }

  s.step += 1;
  askNextQuestion(chatId);
});

console.log("🤖 Interview bot running…");
