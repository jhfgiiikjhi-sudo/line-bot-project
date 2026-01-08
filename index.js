const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");
const officialFacts = require("./officialFacts");

// ================= USER MEMORY =================
const USERS_FILE = "./users.json";
let users = {};

if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ================= LINE CONFIG =================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};
const client = new line.Client(config);

// ================= OpenAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ================= WEBHOOK =================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: "ok" });
  } catch {
    res.status(500).end();
  }
});

// ================= MAIN LOGIC =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text")
    return reply(event, "ขออภัยครับ ข้อความนี้ไม่รองรับ 😊");

  const userId = event.source?.userId;
  if (!userId) return reply(event, "ไม่สามารถระบุตัวตนผู้ใช้ได้ครับ");

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) return reply(event, "กรุณาพิมพ์ข้อความก่อนนะครับ 😊");

  // ===== CREATE USER =====
  if (!users[userId]) {
    users[userId] = { step: "ask_name" };
    saveUsers();
    return reply(event, "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ");
  }

  const user = users[userId];

  // ================= RESET NAME (GLOBAL) =================
  if (
    lowerText.includes("เปลี่ยนชื่อ") ||
    lowerText.includes("ขอพิมพ์ชื่อใหม่")
  ) {
    user.step = "ask_name";
    delete user.name;
    saveUsers();
    return reply(event, "ได้เลยครับ 😊 กรุณาพิมพ์ชื่อใหม่ของคุณ");
  }

  // ================= ASK NAME (VERY STRICT) =================
if (user.step === "ask_name") {
  const bannedWords = [
    "ข้าม",
    "skip",
    "ไม่บอก",
    "ไม่บอกชื่อ",
    "test",
    "ทดสอบ",
    "123",
    "abc",
    "xxx",
    "zzz",
    "aaaa",
    "bbbb"
  ];

  // ❌ ตัวอักษรซ้ำทั้งหมด เช่น แแ / aa / กกก
  const allSameChar = /^(.)(\1)+$/.test(userText);

  // ❌ อังกฤษล้วน (กัน aa / asdf)
  const englishOnly = /^[a-zA-Z]+$/.test(userText);

  // ❌ ไทยล้วนแต่ไม่มีสระ (เช่น กกำร่ดำดำ / ออกา่อาก่อก)
  const thaiOnly = /^[ก-ฮ]+$/.test(userText);
  const hasThaiVowel = /[ะาิีึืุูเแโใไำ]/.test(userText);
  const thaiNoVowel = thaiOnly && !hasThaiVowel;

  // ❌ ความยาว / รูปแบบ
  const invalidLength = userText.length < 2 || userText.length > 20;
  const invalidCharset = !/^[ก-๙a-zA-Z\s]+$/.test(userText);

  if (
    bannedWords.includes(lowerText) ||
    allSameChar ||
    englishOnly ||
    thaiNoVowel ||
    invalidLength ||
    invalidCharset
  ) {
    return reply(
      event,
      "❌ กรุณาพิมพ์ชื่อจริงที่ใช้เรียก (ภาษาไทยหรืออังกฤษ 2–20 ตัวอักษร)\n*ขั้นตอนนี้ไม่สามารถข้ามได้ครับ*"
    );
  }

  // ✅ ผ่านการตรวจ
  user.name = userText;
  user.step = "ask_age";
  saveUsers();

  return reply(
    event,
    `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`
  );
}


  // ================= ASK AGE (STRICT) =================
  if (user.step === "ask_age") {
    if (["ข้าม", "skip", "ไม่บอก"].includes(lowerText)) {
      return reply(event, "❌ ขั้นตอนอายุไม่สามารถข้ามได้ครับ");
    }

    const age = Number(userText);
    if (!Number.isInteger(age) || age < 1 || age > 60) {
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60 เท่านั้น");
    }

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();
    return reply(
      event,
      "วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ \"ข้าม\""
    );
  }

  // ================= ASK BIRTHDAY (OPTIONAL) =================
  if (user.step === "ask_birthday") {
    if (["ข้าม", "skip", "ไม่บอก"].includes(lowerText)) {
      user.birthday = null;
      user.step = "done";
      saveUsers();
      return reply(
        event,
        `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด: ไม่ได้ระบุ`
      );
    }

    if (!moment(userText, "DD/MM/YYYY", true).isValid()) {
      return reply(
        event,
        "❌ รูปแบบวันเกิดไม่ถูกต้อง\nกรุณาพิมพ์ DD/MM/YYYY หรือพิมพ์ \"ข้าม\""
      );
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();
    return reply(
      event,
      `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด ${user.birthday}`
    );
  }

  // ================= TIME / DATE =================
  const now = moment().tz("Asia/Bangkok").locale("th");

  if (lowerText.includes("เวลา") || lowerText.includes("กี่โมง")) {
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  }

  // ================= BIRTHDAY COUNTDOWN =================
  if (lowerText.includes("วันเกิด")) {
    if (!user.birthday)
      return reply(event, "คุณยังไม่ได้บอกวันเกิดไว้ครับ");

    const [d, m] = user.birthday.split("/");
    let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
    if (next.isBefore(now, "day")) next.add(1, "year");

    const diff = next.startOf("day").diff(now.startOf("day"), "days");
    return reply(event, `🎂 เหลืออีก ${diff} วัน จะถึงวันเกิดของคุณครับ`);
  }

  // ================= FUTURE BLOCK =================
  if (
    lowerText.includes("นายก") &&
    (lowerText.includes("ต่อไป") ||
      lowerText.includes("อนาคต") ||
      lowerText.includes("คนหน้า"))
  ) {
    return reply(
      event,
      "ขออภัยครับ 🙏 เรื่องอนาคตยังไม่สามารถยืนยันได้ ผมไม่สามารถคาดเดาได้ครับ"
    );
  }

  // ================= OFFICIAL FACTS =================
  if (lowerText.includes("นายก")) {
    return reply(
      event,
      `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`
    );
  }

  // ================= AI FALLBACK =================
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "คุณคือแชทบอทภาษาไทย สุภาพ ห้ามเดาข้อมูลทางการ ถ้าไม่แน่ใจให้ปฏิเสธอย่างสุภาพ",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 200,
    });

    return reply(event, completion.choices[0].message.content);
  } catch {
    return reply(event, "ขออภัยครับ ระบบตอบช้าชั่วคราว 🙏");
  }
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ================= TEST =================
app.get("/", (req, res) => res.send("ok"));
app.listen(8080, () => console.log("🚀 Server running"));
