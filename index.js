// ================================
// STC Chatbot - index.js
// ================================

const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");
const officialFacts = require("./officialFacts");

// ================= FILE =================
const USERS_FILE = "./users.json";
const NAME_STATS_FILE = "./name_stats.json";

let users = {};
let nameStats = { real: {}, nick: {} };

if (fs.existsSync(USERS_FILE)) {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch {}
}
if (fs.existsSync(NAME_STATS_FILE)) {
  try { nameStats = JSON.parse(fs.readFileSync(NAME_STATS_FILE, "utf8")); } catch {}
}

const saveUsers = () =>
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const saveStats = () =>
  fs.writeFileSync(NAME_STATS_FILE, JSON.stringify(nameStats, null, 2));

// ================= LINE =================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};
const client = new line.Client(config);

// ================= OpenAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ================= UTILITIES =================
function isRepeatedChars(text) {
  return /^(.)(\1{2,})$/.test(text);
}

function looksRandom(text) {
  const vowels = text.match(/[aeiouกะาิีึืุูเแโใไ]/gi) || [];
  return vowels.length < text.length / 5;
}

function isValidRealName(text) {
  if (!/^[A-Za-zก-๙]{2,20}$/.test(text)) return false;
  if (isRepeatedChars(text)) return false;
  if (looksRandom(text)) return false;
  return true;
}

function isValidNickName(text) {
  if (!/^[A-Za-zก-๙]{1,15}$/.test(text)) return false;
  if (isRepeatedChars(text)) return false;
  return true;
}

function isValidAge(text) {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 80;
}

// ================= WEBHOOK =================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ================= MAIN =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text")
    return reply(event, "ขออภัยครับ ข้อความนี้ไม่รองรับ 😊");

  const userId = event.source?.userId;
  if (!userId) return reply(event, "ไม่สามารถระบุตัวตนผู้ใช้ได้ครับ");

  const text = event.message.text.trim();
  const lower = text.toLowerCase();
  const now = moment().tz("Asia/Bangkok").locale("th");

  if (!users[userId]) {
    users[userId] = { step: "ask_realname" };
    saveUsers();
    return reply(event, "สวัสดีครับ 😊\nกรุณาพิมพ์ **ชื่อจริง** ของคุณ");
  }

  const user = users[userId];

  // ================= CHANGE COMMANDS =================
  if (lower === "เปลี่ยนชื่อ") {
    user.step = "ask_realname";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อจริงใหม่");
  }

  if (lower === "เปลี่ยนชื่อเล่น") {
    user.step = "ask_nickname";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อเล่นใหม่");
  }

  if (lower === "เปลี่ยนอายุ") {
    user.step = "ask_age";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์อายุของคุณ");
  }

  // ================= ASK REAL NAME =================
  if (user.step === "ask_realname") {
    if (text === "ข้าม")
      return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้");

    if (!isValidRealName(text))
      return reply(event, "❌ กรุณาพิมพ์ชื่อจริงที่อ่านได้ (ไทย/อังกฤษ 2–20 ตัว)");

    user.realName = text;
    user.step = "ask_nickname";
    saveUsers();
    return reply(event, `ขอบคุณครับ ${text} 😊\nขอทราบ **ชื่อเล่น** ด้วยครับ`);
  }

  // ================= ASK NICKNAME =================
  if (user.step === "ask_nickname") {
    if (text === "ข้าม")
      return reply(event, "❌ ไม่สามารถข้ามชื่อเล่นได้");

    if (!isValidNickName(text))
      return reply(event, "❌ ชื่อเล่นไม่ถูกต้อง");

    user.nickName = text;
    user.step = "ask_age";
    saveUsers();
    return reply(event, "สุดท้ายแล้วครับ 🎂\nคุณอายุเท่าไหร่?");
  }

  // ================= ASK AGE =================
  if (user.step === "ask_age") {
    if (!isValidAge(text))
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–80");

    user.age = Number(text);
    user.step = "ask_birthday";
    saveUsers();
    return reply(
      event,
      "วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ \"ข้าม\""
    );
  }

  // ================= ASK BIRTHDAY =================
  if (user.step === "ask_birthday") {
    if (!["ข้าม", "skip"].includes(lower)) {
      if (!moment(text, "DD/MM/YYYY", true).isValid())
        return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง");
      user.birthday = text;
    } else {
      user.birthday = null;
    }

    user.step = "done";

    nameStats.real[user.realName] =
      (nameStats.real[user.realName] || 0) + 1;
    nameStats.nick[user.nickName] =
      (nameStats.nick[user.nickName] || 0) + 1;

    saveUsers();
    saveStats();

    return reply(
      event,
      `✅ ลงทะเบียนสำเร็จ\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n🎂 อายุ ${user.age} ปี`
    );
  }

  // ================= TOP NAME =================
  if (lower === "/topname") {
    const top = (obj) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, c]) => `${n} (${c})`)
        .join("\n") || "-";

    return reply(
      event,
      `📊 ชื่อยอดนิยม\n\n🪪 ชื่อจริง:\n${top(nameStats.real)}\n\n🎭 ชื่อเล่น:\n${top(nameStats.nick)}`
    );
  }

  // ================= TIME =================
  if (lower.includes("เวลา"))
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);

  // ================= BIRTHDAY COUNTDOWN =================
  if (lower.includes("วันเกิด") && user.birthday) {
    const [d, m] = user.birthday.split("/");
    let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
    if (next.isBefore(now, "day")) next.add(1, "year");
    return reply(event, `🎂 เหลืออีก ${next.diff(now, "days")} วันจะถึงวันเกิดคุณครับ`);
  }

  // ================= OFFICIAL FACT =================
  if (lower.includes("นายก"))
    return reply(
      event,
      `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`
    );

  // ================= AI FALLBACK =================
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือแชทบอทสุภาพ ห้ามเดาข้อมูล" },
        { role: "user", content: text },
      ],
      max_tokens: 200,
    });
    return reply(event, res.choices[0].message.content);
  } catch {
    return reply(event, "ขออภัยครับ ระบบตอบช้าชั่วคราว 🙏");
  }
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: "text", text });
}

app.get("/", (_, res) => res.send("ok"));
app.listen(8080, () => console.log("🚀 Server running"));
