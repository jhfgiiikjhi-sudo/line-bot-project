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
  } catch (err) {
    console.error("users.json เสียหรืออ่านไม่ได้", err);
    users = {};
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("ไม่สามารถบันทึก users.json ได้", err);
  }
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
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

// ================= MAIN LOGIC =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userId = event.source?.userId;
  if (!userId) return null;

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) return reply(event, "พิมพ์ข้อความมาก่อนนะครับ");

  // ===== CREATE USER =====
  if (!users[userId]) {
    users[userId] = { step: "intro" };
    saveUsers();
    return reply(
      event,
      "สวัสดีครับ 😊\nก่อนคุยกัน ผมขอรู้จักคุณหน่อย\n\nคุณชื่ออะไรครับ?"
    );
  }

  const user = users[userId];

  // ================= GREETING =================
  if (lowerText.includes("สวัสดี")) {
    if (!user.name) {
      return reply(event, "สวัสดีครับ 😊\nขอทราบชื่อคุณหน่อยได้ไหมครับ");
    }
    return reply(event, `สวัสดีครับ ${user.name} 😊\nมีอะไรให้ผมช่วยไหมครับ`);
  }

  // ===== ASK NAME =====
  if (user.step === "intro") {
    user.name = userText;
    user.step = "ask_age";
    saveUsers();
    return reply(event, `ยินดีที่ได้รู้จักครับ ${user.name}\nคุณอายุเท่าไหร่ครับ?`);
  }

  // ===== ASK AGE =====
  if (user.step === "ask_age") {
    const age = Number(userText);
    if (!Number.isInteger(age) || age <= 0 || age > 60) {
      return reply(event, "กรุณาพิมพ์อายุเป็นตัวเลข 1–60 ปีนะครับ");
    }

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();

    return reply(
      event,
      "วันเกิดของคุณวันที่เท่าไหร่ครับ?\n(ตัวอย่าง: 20/11/2548)\nหรือพิมพ์ \"ข้าม\" หากไม่ต้องการบอก"
    );
  }

  // ===== ASK BIRTHDAY (OPTIONAL) =====
  if (user.step === "ask_birthday") {
    if (["ข้าม", "ไม่บอก", "skip"].includes(lowerText)) {
      user.birthday = null;
      user.step = "done";
      saveUsers();

      return reply(
        event,
        `ขอบคุณครับ 🙏\n\n👤 ชื่อ: ${user.name}\n🎂 อายุ: ${user.age}\n📅 วันเกิด: ไม่ได้ระบุ`
      );
    }

    if (!moment(userText, "DD/MM/YYYY", true).isValid()) {
      return reply(
        event,
        "วันเกิดไม่ถูกต้องตามปฏิทินครับ\nหรือพิมพ์ \"ข้าม\" ได้"
      );
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();

    return reply(
      event,
      `ขอบคุณครับ 🙏\n\n👤 ชื่อ: ${user.name}\n🎂 อายุ: ${user.age}\n📅 วันเกิด: ${user.birthday}`
    );
  }

  // ================= TIME / DATE =================
  const now = moment().tz("Asia/Bangkok").locale("th");
  const buddhistYear = (now.year() + 543) % 100;

  if (lowerText.includes("กี่โมง") || lowerText.includes("เวลา")) {
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  }

  if (lowerText.includes("วันนี้")) {
    return reply(
      event,
      `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM")} ${buddhistYear}`
    );
  }

  // ================= COUNTDOWN : NEW YEAR =================
  if (lowerText.includes("ปีใหม่")) {
    const nextYear = now.year() + 1;
    const newYear = moment.tz(`${nextYear}-01-01`, "Asia/Bangkok");
    const diff = newYear.startOf("day").diff(now.startOf("day"), "days");

    return reply(
      event,
      `🎆 เหลืออีก ${diff} วัน จะถึงวันปีใหม่ (1 ม.ค. ${(nextYear + 543) % 100})`
    );
  }

  // ================= COUNTDOWN : EXAM =================
  if (lowerText.includes("สอบ")) {
    const examDate = moment.tz("2025-12-20", "Asia/Bangkok");
    const diff = examDate.startOf("day").diff(now.startOf("day"), "days");

    if (diff < 0) return reply(event, "📘 วันสอบผ่านไปแล้วครับ");

    return reply(
      event,
      `📚 เหลืออีก ${diff} วัน จะถึงวันสอบ (${examDate.format("D MMMM")} ${(examDate.year() + 543) % 100})`
    );
  }

  // ================= COUNTDOWN : BIRTHDAY =================
  if (lowerText.includes("วันเกิด")) {
    if (!user.birthday) {
      return reply(event, "คุณยังไม่ได้บอกวันเกิดไว้ครับ");
    }

    const [d, m] = user.birthday.split("/");
    let birthday = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
    if (birthday.isBefore(now, "day")) birthday.add(1, "year");

    const diff = birthday.startOf("day").diff(now.startOf("day"), "days");
    return reply(event, `🎂 เหลืออีก ${diff} วัน จะถึงวันเกิดของคุณครับ 🎉`);
  }

  // ================= OFFICIAL FACTS =================
  if (lowerText.includes("นายก")) {
    return reply(event, `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`);
  }

  if (lowerText.includes("เมืองหลวง")) {
    return reply(event, `เมืองหลวงของประเทศไทยคือ ${officialFacts.capital} ครับ`);
  }

  if (lowerText.includes("สกุลเงิน")) {
    return reply(event, `สกุลเงินของประเทศไทยคือ ${officialFacts.currency} ครับ`);
  }

  if (lowerText.includes("เบอร์ฉุกเฉิน")) {
    return reply(
      event,
      `📞 เบอร์ฉุกเฉินในประเทศไทย\n🚓 ตำรวจ: ${officialFacts.emergency.police}\n🚑 รถพยาบาล: ${officialFacts.emergency.ambulance}\n🔥 ดับเพลิง: ${officialFacts.emergency.fire}`
    );
  }

  // ================= AI RESPONSE =================
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
คุณคือแชทบอทภาษาไทย สุภาพ เป็นกันเอง
ข้อมูลทางการ:
- นายกรัฐมนตรี: ${officialFacts.primeMinister}
- เมืองหลวง: ${officialFacts.capital}
- สกุลเงิน: ${officialFacts.currency}

กฎ:
- ห้ามเดาข้อมูลทางการ
- ถ้าไม่แน่ใจ ให้ปฏิเสธอย่างสุภาพ
`,
        },
        { role: "user", content: userText },
      ],
      max_tokens: 300,
    });

    return reply(event, completion.choices[0].message.content);
  } catch (err) {
    console.error("AI Error:", err);
    return reply(event, "ขออภัยครับ ระบบ AI มีปัญหาชั่วคราว 😢");
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

app.listen(8080, () =>
  console.log("🚀 Server running on port 8080")
);
