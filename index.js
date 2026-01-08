const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");
const officialFacts = require("./officialFacts");

// ================== LINE CONFIG ==================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};
const client = new line.Client(config);

// ================== OpenAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ================== USER MEMORY ==================
const USERS_FILE = "./users.json";
let users = {};

try {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  }
} catch {
  users = {};
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("❌ Save users.json failed", err);
  }
}

// ================== VALIDATORS ==================
function isValidName(text) {
  return /^[ก-๙a-zA-Z\s]{2,30}$/.test(text);
}

function isValidAge(text) {
  if (!/^\d+$/.test(text)) return false;
  const age = Number(text);
  return age >= 1 && age <= 60;
}

function isValidBirthday(text) {
  return moment(text, "DD/MM/YYYY", true).isValid();
}

// ================== WEBHOOK ==================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook Error", err);
    res.status(500).end();
  }
});

// ================== MAIN ==================
async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยครับ ผมรองรับเฉพาะข้อความ 😊",
      });
    }

    const userId = event.source?.userId;
    if (!userId) return null;

    const text = event.message.text.trim();
    const lower = text.toLowerCase();

    if (!text) {
      return reply(event, "กรุณาพิมพ์ข้อความก่อนนะครับ 😊");
    }

    // ===== INIT USER =====
    if (!users[userId]) {
      users[userId] = { step: "intro" };
      saveUsers();
      return reply(
        event,
        "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ"
      );
    }

    const user = users[userId];
    const lockedSteps = ["intro", "ask_age", "ask_birthday"];

    // ===== BLOCK RANDOM QUESTIONS DURING FORM =====
    if (
      lockedSteps.includes(user.step) &&
      (lower.includes("กี่โมง") ||
        lower.includes("วันนี้") ||
        lower.includes("นายก") ||
        lower.includes("เพลง") ||
        lower.includes("youtube"))
    ) {
      return reply(
        event,
        "⛔ กรุณาตอบคำถามให้ครบก่อนนะครับ แล้วผมจะช่วยต่อทันที 😊"
      );
    }

    // ================= FORM FLOW =================
    if (user.step === "intro") {
      if (!isValidName(text)) {
        return reply(
          event,
          "❌ ชื่อไม่ถูกต้อง\nกรุณาพิมพ์ชื่อจริง (ภาษาไทย/อังกฤษ) 2–30 ตัวอักษร"
        );
      }
      user.name = text;
      user.step = "ask_age";
      saveUsers();
      return reply(event, `ยินดีที่ได้รู้จักครับ ${user.name}\nคุณอายุเท่าไหร่ครับ?`);
    }

    if (user.step === "ask_age") {
      if (!isValidAge(text)) {
        return reply(
          event,
          "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60 เท่านั้น"
        );
      }
      user.age = Number(text);
      user.step = "ask_birthday";
      saveUsers();
      return reply(
        event,
        "วันเกิดของคุณคือวันไหนครับ?\nรูปแบบ DD/MM/YYYY\nหรือพิมพ์ \"ข้าม\""
      );
    }

    if (user.step === "ask_birthday") {
      if (["ข้าม", "ไม่บอก", "skip"].includes(lower)) {
        user.birthday = null;
        user.step = "done";
        saveUsers();
        return reply(
          event,
          `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age}\n📅 วันเกิด: ไม่ระบุ`
        );
      }

      if (!isValidBirthday(text)) {
        return reply(
          event,
          "❌ วันเกิดไม่ถูกต้อง\nกรุณาพิมพ์ DD/MM/YYYY เช่น 20/11/2548"
        );
      }

      user.birthday = text;
      user.step = "done";
      saveUsers();
      return reply(
        event,
        `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age}\n📅 วันเกิด ${user.birthday}`
      );
    }

    // ================= TIME =================
    const now = moment().tz("Asia/Bangkok").locale("th");

    if (lower.includes("กี่โมง")) {
      return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
    }

    if (lower.includes("วันนี้")) {
      return reply(
        event,
        `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM")} ${now.year() + 543}`
      );
    }

    // ================= BIRTHDAY COUNTDOWN =================
    if (lower.includes("วันเกิด")) {
      if (!user.birthday) {
        return reply(event, "คุณยังไม่ได้บอกวันเกิดไว้ครับ");
      }

      const [d, m] = user.birthday.split("/");
      let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
      if (next.isBefore(now, "day")) next.add(1, "year");

      const diff = next.diff(now.startOf("day"), "days");
      return reply(event, `🎂 เหลืออีก ${diff} วัน จะถึงวันเกิดคุณครับ 🎉`);
    }

    // ================= FUTURE BLOCK =================
    if (
      lower.includes("นายก") &&
      (lower.includes("ต่อไป") || lower.includes("ในอนาคต"))
    ) {
      return reply(
        event,
        "ขออภัยครับ 🙏 ผมไม่สามารถคาดเดาเหตุการณ์ในอนาคตได้"
      );
    }

    // ================= OFFICIAL FACTS =================
    if (lower.includes("นายก")) {
      return reply(
        event,
        `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`
      );
    }

    // ================= AI (SAFE) =================
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "คุณเป็นแชทบอทภาษาไทย สุภาพ ไม่เดา ไม่มั่ว ถ้าไม่แน่ใจให้ปฏิเสธ",
          },
          { role: "user", content: text },
        ],
        max_tokens: 300,
      });

      return reply(event, completion.choices[0].message.content);
    } catch {
      return reply(event, "ระบบตอบช้าชั่วคราว ขออภัยครับ 🙏");
    }
  } catch (err) {
    console.error("❌ handleEvent error", err);
    return reply(event, "เกิดข้อผิดพลาดชั่วคราว ขออภัยครับ 🙏");
  }
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ================= SERVER =================
app.get("/", (_, res) => res.send("OK"));
app.listen(8080, () => console.log("🚀 Bot running"));
