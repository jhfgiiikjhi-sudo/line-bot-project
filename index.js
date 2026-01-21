// ========================================
// STC Chatbot - index.js (ULTIMATE FINAL COMPLETE)
// ========================================

const mongoose = require("mongoose");
const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");

const collegeData = require("./collegeData");
const officialFacts = require("./officialFacts");
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("🍃 Connected to MongoDB Successfully!"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// 2. สร้างโครงสร้างข้อมูล (Schema)
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  realName: String,
  nickName: String,
  age: Number,
  department: String,
  birthday: String,
  step: { type: String, default: "ask_realname" },
  badCount: { type: Number, default: 0 },
  blockedUntil: Date,
  tempReport: {
    title: String,
    detail: String
  }
});

const User = mongoose.model("User", userSchema);

// รายชื่อสาขา
const DEPARTMENTS = [
  "ช่างยนต์", "ช่างไฟฟ้ากำลัง", "ช่างอิเล็กทรอนิกส์", 
  "ช่างกลโรงงาน", "ช่างก่อสร้าง", "ช่างเชื่อมโลหะ", 
  "การบัญชี", "การตลาด", "เทคโนโลยีสารสนเทศ", "IT", "It", "it", 
  "คอมพิวเตอร์กราฟิก", "การจัดการโลจิสติกส์", "ช่างอากาศยาน"
];

// ========================================
// FILE STORAGE (ระบบสถิติชื่อ)
// ========================================
const NAME_STATS_FILE = "./name_stats.json";
let nameStats = { real: {}, nick: {} };

// โหลดข้อมูลสถิติ
const loadData = () => {
    try {
        if (fs.existsSync(NAME_STATS_FILE)) {
            const statsData = fs.readFileSync(NAME_STATS_FILE, "utf8");
            nameStats = statsData ? JSON.parse(statsData) : { real: {}, nick: {} };
        }
    } catch (e) {
        console.error("❌ Error loading data:", e);
        nameStats = { real: {}, nick: {} };
    }
};
loadData();

// บันทึกสถิติ
const saveStats = () => {
    try {
        const data = nameStats || { real: {}, nick: {} };
        fs.writeFileSync(NAME_STATS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        console.error("❌ Save Stats Error:", e);
    }
};

// ========================================
// LINE & OPENAI CONFIG
// ========================================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};
const client = new line.Client(config);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ========================================
// UTIL (VALIDATION ฟังก์ชันตรวจสอบทั้งหมด)
// ========================================
const FORBIDDEN_NAMES = [
  "สวัสดี","หวัดดี","ขอบคุณ","ครับ","ค่ะ","ดีครับ","ดีค่ะ",
  "hello","hi","hey","ok","okay","test","ทดสอบ",
  "admin","user","bot","system"
];

const isForbidden = (t) => FORBIDDEN_NAMES.includes(t.toLowerCase());
const isRepeated = (t) => /^(.)(\1{2,})$/.test(t);

const validThaiEng = (t, min, max) =>
  /^[ก-๙a-zA-Z]+$/.test(t) && t.length >= min && t.length <= max;

function isStrictlyHumanName(text) {
  if (/(.)\1{3,}/.test(text)) return false;
  if (!/^[a-zA-Zก-๙\s]+$/.test(text)) return false;
  const hasThaiVowel = /[ะาิีึืุูเแโใไำั]/.test(text);
  const keyboardSmash = /[ก-ฮ]{4,}/g; 
  if (keyboardSmash.test(text) && !text.includes("์") && !hasThaiVowel) return false; 
  if (/^[ะาิีึืุูํั].*/.test(text)) return false; 
  if (/.*[เแโใไ]$/.test(text)) return false; 
  if (text.length < 3 || text.length > 30) return false;
  return true;
}

function isHumanName(text, min, max) {
  if (!validThaiEng(text, min, max)) return false;
  if (isForbidden(text) || isRepeated(text)) return false;
  if (/^[ก-ฮ]+$/.test(text) && !/[ะาิีึืุูเแโใไำั็]/.test(text)) return false;
  if (/^[a-zA-Z]+$/.test(text) && !/[aeiou]/i.test(text)) return false;
  return true;
}

function looksSwapped(real, nick) {
  if (!real || !nick) return false;
  if (nick.length >= real.length + 3) return true;
  if (real.length <= 3 && nick.length >= 6) return true;
  return false;
}

function isLikelyNickname(text) {
  if (text.length <= 4) return true;
  if (text.length >= 8) return false;
  return true;
}

const BAD_WORDS = [
  "ควย","เหี้ย","สัส","ห่า","หี","ชิบหาย","ฉิบหาย", "เย็ด" ,"น่าหี" ,"ลูกกะหรี่",
  "fuck","shit","bitch","asshole","motherfucker" ,"Hee","Fuckyou" ,"Kuy" ,"yed" 
];

function normalizeBadWord(text) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function hasBadWord(text) {
  const clean = normalizeBadWord(text);
  return BAD_WORDS.some(word => clean.includes(word));
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, "").replace(/[_\-\.]/g, "");
}

const BAD_PATTERNS = [
  /ค+ว+ย+/, /ค+_+ว+_+ย+/, /ค+\s*ว+\s*ย+/,
  /เห+ี+้*ย+/, /ส+ั+ส+/, /ห+ี+/, /ช+ิ+บ+ห+า+ย+/, /เย+็+ด+/,
  /f+u+c+k+/i, /s+h+i+t+/i, /b+i+t+c+h+/i, /a+s+s+h+o+l+e+/i, /h+e+e+/i, /k+u+y+/i, /y+e+d+/i
];

function containsBadWord(text) {
  const clean = normalizeText(text);
  return BAD_PATTERNS.some(pattern => pattern.test(clean));
}

function isSpam(text) {
  if (/^[!?@#\$%\^&\*\(\)\+=\-_.]{3,}$/.test(text)) return true;
  if (/^(.)\1{4,}$/.test(text)) return true;
  return false;
}

function detectMessageType(text) {
  const clean = normalizeText(text);
  if (/^\d+$/.test(clean)) return "normal";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "normal";
  if (containsBadWord(clean)) return "badword";
  if (!/[ก-๙a-z]/i.test(text) || isSpam(text)) return "spam";
  return "normal";
}

// ========================================
// HELPERS (ฟังก์ชันตอบกลับและแจ้งเตือน)
// ========================================
function reply(event, message) {
    return client.replyMessage(event.replyToken, { type: "text", text: message });
}

async function increaseWarning(user) {
    try {
        await client.pushMessage(user.userId, {
            type: "text",
            text: "⚠️ คำเตือน: ระบบตรวจพบข้อความไม่เหมาะสม หากครบ 3 ครั้งจะถูกระงับการใช้งาน"
        });
    } catch (err) {
        console.error("Push Warning Error:", err);
    }
}

// ========================================
// WEBHOOK
// ========================================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ========================================
// MAIN LOGIC - handleEvent
// ========================================
async function handleEvent(event) {
    if (event.type !== "message" || !["text", "image"].includes(event.message.type)) {
        return; 
    }

    const userId = event.source?.userId;
    if (!userId) return;

    let user = await User.findOne({ userId: userId });

    // ===== 1. CREATE USER / INITIAL CHECK =====
    if (!user) {
        user = new User({ userId: userId, step: "ask_realname", badCount: 0 });
        await user.save();
        return reply(event, "สวัสดีครับก่อนเริ่มคุยมาทำความรู้จักกันก่อนนะครับ 😊\nกรุณาพิมพ์ **ชื่อจริง** ของคุณนะครับ");
    }

    // ===== 2. IMAGE LOGIC =====
    if (event.message.type === "image") {
        return await handleImageMessage(event, user); 
    }

    // ===== 3. TEXT LOGIC =====
    const text = event.message.text.trim();
    const lower = text.toLowerCase();
    const now = moment().tz("Asia/Bangkok").locale("th");

    // ===== 4. BLOCKED CHECK =====
    if (user.blockedUntil && moment().isBefore(user.blockedUntil)) {
        const diff = moment(user.blockedUntil).diff(moment(), "seconds");
        return reply(event, `⛔ คุณถูกระงับการใช้งานชั่วคราว\nกรุณารออีก ${diff} วินาที`);
    }

    // ===== 5. GLOBAL BAD WORD & SPAM FILTER =====
    const msgType = detectMessageType(text);
    if (msgType !== "normal") {
        if (user.badCount >= 3) {
            user.blockedUntil = moment().add(1, "minute");
            user.badCount = 0;
            await user.save();
            return reply(event, "⛔ ระบบตรวจพบข้อความไม่เหมาะสมซ้ำหลายครั้ง\nระงับการใช้งาน 1 นาที");
        }
        if (isSpam(text)) {
            return reply(event, "⚠️ ข้อความลักษณะสแปมหรือไม่สื่อความหมาย กรุณาพิมพ์ให้ชัดเจนครับ");
        }
        if (hasBadWord(text)) {
            user.badCount = (user.badCount || 0) + 1;
            await user.save();
            increaseWarning(user); 
            return reply(event, `⚠️ ❌ ข้อความนี้มีถ้อยคำไม่เหมาะสม กรุณาใช้คำสุภาพครับ\n(เตือนครั้งที่ ${user.badCount}/3)`);
        }
    }

    // ===== 6. LENGTH & GARBAGE CHECK =====
    if (text.length > 50 || /^[^ก-๙a-zA-Z0-9\s]+$/.test(text))
        return reply(event, "❌ ข้อความไม่ถูกต้องครับ");

    // ===== 7. CHANGE COMMANDS (คำสั่งเปลี่ยนข้อมูล) =====
    if (lower.includes("เปลี่ยนชื่อเล่น")) {
        user.step = "ask_nickname_only";
        await user.save();
        return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อเล่นใหม่ได้เลย");
    }
    if (lower.includes("เปลี่ยนชื่อ")) {
        user.step = "ask_realname_only";
        await user.save();
        return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อจริงใหม่ได้เลย");
    }
    if (lower.includes("เปลี่ยนอายุ")) {
        user.step = "ask_age_only";
        await user.save();
        return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์อายุใหม่ของคุณ");
    }

    // ===== 8. ส่วนแจ้งปัญหาการใช้งาน =====
    if (lower === "แจ้งปัญหาการใช้งาน") {
        user.step = "report_title";
        await user.save();
        return reply(event, "📢 ยินดีรับเรื่องครับ\nกรุณาพิมพ์ **หัวข้อปัญหา** ที่ต้องการแจ้งครับ");
    }
    if (user.step === "report_title") {
        user.tempReport = { title: text };
        user.step = "report_detail";
        await user.save();
        return reply(event, "ขอบคุณครับ ต่อไปขอทราบ **รายละเอียดของปัญหา** เพิ่มเติมสักเล็กน้อยครับ");
    }
    if (user.step === "report_detail") {
        if (user.tempReport) user.tempReport.detail = text;
        user.step = "report_photo";
        await user.save();
        return reply(event, "บันทึกข้อมูลแล้วครับ คุณต้องการ **ส่งรูปภาพประกอบ** ไหมครับ? (ถ้าไม่มีให้พิมพ์ว่า 'ไม่มี' เพื่อส่งเรื่องทันที)");
    }
    if (user.step === "report_photo") {
        if (lower !== "ไม่มี") {
            return reply(event, "กรุณาส่งรูปภาพประกอบปัญหาได้เลยครับ หรือพิมพ์ 'ไม่มี' เพื่อข้ามขั้นตอนนี้");
        }
        const reportSummary = `✅ บันทึกการแจ้งเรื่องสำเร็จ!\n\n` +
                              `📌 หัวข้อ: ${user.tempReport?.title || "ไม่ระบุ"}\n` +
                              `📝 รายละเอียด: ${user.tempReport?.detail || "ไม่ระบุ"}\n` +
                              `👤 ผู้แจ้ง: ${user.realName} (แผนก ${user.department})`;
        user.step = "done";
        user.tempReport = undefined; 
        await user.save();
        return reply(event, reportSummary);
    }

    // ===== 9. REGISTER FLOW (CORE LOGIC) =====
    
    // STEP: ASK REALNAME
    if (user.step && user.step.startsWith("ask_realname")) {
        const isOnly = user.step.endsWith("_only");
        if (lower === "ข้าม" && !isOnly) return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้\nกรุณาพิมพ์ชื่อจริงของคุณ");
        if (!isStrictlyHumanName(text)) return reply(event, "❌ ดูเหมือนไม่ใช่ชื่อจริงที่ถูกต้องครับ\nกรุณาพิมพ์ชื่อจริงของคุณอีกครั้ง");

        if (user.realName && nameStats.real[user.realName]) {
            nameStats.real[user.realName] = Math.max(0, nameStats.real[user.realName] - 1);
            if (nameStats.real[user.realName] === 0) delete nameStats.real[user.realName];
        }
        user.realName = text;
        nameStats.real[text] = (nameStats.real[text] || 0) + 1;

        const isRegistered = user.nickName && user.age && user.department;
        if (isOnly && isRegistered) {
            user.step = "done";
            await user.save();
            saveStats();
            return reply(event, `✅ เปลี่ยนชื่อจริงสำเร็จแล้วครับ เป็น: **${text}**`);
        } else {
            user.step = "ask_nickname";
            await user.save();
            saveStats();
            return reply(event, `ขอบคุณครับ คุณ${text} 😊\nต่อไปขอทราบ **ชื่อเล่น** ด้วยครับ`);
        }
    }

    // STEP: ASK NICKNAME
    if (user.step && user.step.startsWith("ask_nickname")) {
        const isOnly = user.step.endsWith("_only");
        if (!isHumanName(text, 1, 15)) return reply(event, "❌ กรุณาใช้ชื่อที่สุภาพครับ");
        if (text === user.realName) return reply(event, "⚠️ ชื่อเล่นไม่ควรซ้ำกับชื่อจริงครับ");
        if (!isLikelyNickname(text)) return reply(event, "⚠️ ชื่อเล่นมักจะสั้นกว่านี้นะครับ\nถ้านี่คือชื่อเล่นจริง ๆ ให้พิมพ์ซ้ำอีกครั้งได้เลย 😊");

        if (!isOnly && looksSwapped(user.realName, text)) {
            user.realName = ""; 
            user.step = "ask_realname"; 
            await user.save();
            return reply(event, "⚠️ ดูเหมือนใส่ชื่อสลับกันครับ\nกรุณาพิมพ์ **ชื่อจริง** ใหม่อีกครั้ง");
        }

        if (isOnly && user.nickName) {
            nameStats.nick[user.nickName] = Math.max(0, (nameStats.nick[user.nickName] || 1) - 1);
            if (nameStats.nick[user.nickName] === 0) delete nameStats.nick[user.nickName];
        }
        user.nickName = text;
        nameStats.nick[text] = (nameStats.nick[text] || 0) + 1;

        if (isOnly) {
            user.step = "done";
            await user.save();
            saveStats();
            return reply(event, `✅ เปลี่ยนชื่อเล่นสำเร็จแล้วครับ เป็น: **${text}**`);
        } else {
            user.step = "ask_age";
            await user.save();
            saveStats();
            return reply(event, "ต่อไปขอทราบอายุของคุณครับ 🎂");
        }
    }

    // STEP: ASK AGE
    if (user.step && user.step.startsWith("ask_age")) {
        const ageInput = parseInt(text);
        const isOnly = user.step.endsWith("_only");
        if (isNaN(ageInput) || ageInput < 1 || ageInput > 60) return reply(event, "❌ อายุควรเป็นตัวเลข 1-60 ปีครับ");
        user.age = ageInput;
        if (isOnly) {
            user.step = "done";
            await user.save();
            return reply(event, `✅ เปลี่ยนอายุสำเร็จแล้วครับ เป็น: **${ageInput} ปี**`);
        } else {
            user.step = "ask_birthday";
            await user.save();
            return reply(event, 'ต้องการบอกวันเกิดไหมครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ "ข้าม"');
        }
    }

    // STEP: ASK BIRTHDAY
    if (user.step === "ask_birthday") {
        if (lower === "ข้าม") {
            user.birthday = null;
        } else {
            if (!moment(text, "DD/MM/YYYY", true).isValid()) {
                return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้องครับ (ตัวอย่าง: 20/11/2548)");
            }
            user.birthday = text;
        }
        user.step = "ask_department"; 
        await user.save();
        return reply(event, `ต่อไปขอทราบ **สาขาวิชา** ของคุณครับ\nตัวอย่าง: ช่างยนต์, เทคโนโลยีสารสนเทศ`);
    }

    // STEP: ASK DEPARTMENT
    if (user.step === "ask_department") {
        const foundDept = DEPARTMENTS.find(d => text.includes(d));
        if (!foundDept) return reply(event, `❌ ไม่พบสาขาวิชานี้ในระบบของ SPTC\nกรุณาพิมพ์ชื่อสาขาให้ถูกต้อง`);
        user.department = foundDept;
        user.step = "done";
        await user.save();
        saveStats();
        return reply(event, `✅ ลงทะเบียนสำเร็จ!\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n⚙️ แผนก ${user.department}\n🎂 อายุ ${user.age} ปี`);
    }

    // ===== 10. MULTI INTENT (TIME/DATE/AGE) =====
    const answers = [];
    if (lower.includes("กี่โมง") || lower.includes("เวลา")) answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
    if (lower.includes("วันที่") || lower.includes("วันอะไร")) answers.push(`📅 วันนี้วันที่ ${now.format("D MMMM YYYY")}`);
    if (lower.includes("ปีอะไร")) answers.push(`🗓 ปี พ.ศ. ${now.year() + 543}`);
    if (lower.includes("อายุ")) answers.push(user.age ? `🎂 คุณอายุ ${user.age} ปีครับ` : "❗ ยังไม่ได้บันทึกอายุ");
    if (lower.includes("วันเกิด")) {
        if (!user.birthday) {
            answers.push("❗ คุณยังไม่ได้บันทึกวันเกิดครับ");
        } else {
            const parts = user.birthday.split("/");
            const d = parseInt(parts[0]), m = parseInt(parts[1]);
            let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
            if (next.isBefore(now, "day")) next.add(1, "year");
            answers.push(`🎂 เหลืออีก ${next.diff(now, "days")} วันจะถึงวันเกิดคุณครับ`);
        }
    }
    if (answers.length > 0) return reply(event, answers.join("\n"));

    // ===== 11. TOP NAME COMMAND =====
    if (lower === "/topname") {
        const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join("\n") || "-";
        return reply(event, `📊 ชื่อยอดนิยม\n\n🪪 ชื่อจริง:\n${top(nameStats.real)}\n\n🎭 ชื่อเล่น:\n${top(nameStats.nick)}`);
    }

    // ===== 12. OFFICIAL FACT & USER INFO =====
    if (lower.includes("นายก")) return reply(event, `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`);
    if (lower.includes("ข้อมูลส่วนตัว") || lower.includes("ขอดูข้อมูล")) {
        const userInfo = `📋 **ข้อมูลสมาชิกของคุณ**\n------------------\n👤 ชื่อ: ${user.realName}\n🎭 ชื่อเล่น: ${user.nickName}\n⚙️ แผนก: ${user.department}\n🎂 อายุ: ${user.age} ปี\n📅 วันเกิด: ${user.birthday || "ไม่ได้ระบุ"}\n------------------\n💡 แก้ไขข้อมูลได้โดยพิมพ์: "เปลี่ยนชื่อ" หรือ "เปลี่ยนอายุ"`;
        return reply(event, userInfo);
    }

    // ===== 13. AI FALLBACK (GPT-4o-mini) =====
    try {
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `คุณคือผู้ช่วยอัจฉริยะของ ${collegeData.collegeName} ข้อมูลอ้างอิง: ${JSON.stringify(collegeData)} กฎ: 1.ใช้ข้อมูลอ้างอิงเป็นหลัก 2.สุภาพ 3.ไม่รู้ให้บอกติดต่อแผนกที่เกี่ยวข้อง` },
                { role: "user", content: text },
            ],
            max_tokens: 400,
        });
        return reply(event, res.choices[0].message.content);
    } catch (err) {
        console.error("AI Error:", err);
        return reply(event, "ขออภัยครับ ตอนนี้ระบบสมองกลขัดข้องชั่วคราว 🙏");
    }
}

// ========================================
// IMAGE PROCESSING FUNCTION
// ========================================
async function handleImageMessage(event, user) {
    try {
        if (!user || (user.step !== "done" && user.step !== "report_photo")) {
            return reply(event, "⚠️ กรุณาลงทะเบียนให้เสร็จก่อนส่งรูปภาพนะครับ");
        }
        const stream = await client.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);
        const base64Image = buffer.toString("base64");

        if (user.step === "report_photo") {
            const successMsg = `✅ ได้รับรูปภาพประกอบการแจ้งเรื่องแล้ว!\n\n📌 หัวข้อ: ${user.tempReport?.title || "ไม่ระบุ"}\n📝 รายละเอียด: ${user.tempReport?.detail || "ไม่ระบุ"}\n👤 ผู้แจ้ง: ${user.realName}\n\nระบบได้บันทึกเรื่องเรียบร้อยแล้วครับ 🙏`;
            user.step = "done";
            user.tempReport = undefined;
            await user.save();
            return reply(event, successMsg);
        }

        if (user.step === "done") {
            await reply(event, "🤖 รับทราบครับ กำลังใช้ AI วิเคราะห์รูปภาพสักครู่นะเป็นวิทยาทาน...");
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: `นี่คือรูปภาพจากนักเรียนชื่อ ${user.realName} แผนก ${user.department} ช่วยวิเคราะห์รูปนี้อย่างสุภาพในฐานะผู้ช่วยวิทยาลัย` },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                    ],
                }],
                max_tokens: 500,
            });
            return client.pushMessage(user.userId, { type: "text", text: "🔍 ผลการวิเคราะห์รูปภาพ:\n\n" + response.choices[0].message.content });
        }
    } catch (err) {
        console.error("AI Vision Error:", err);
        return client.pushMessage(user.userId, { type: "text", text: "❌ ขออภัยครับ ระบบไม่สามารถประมวลผลรูปภาพได้" });
    }
}

// ========================================
// SERVER START
// ========================================
app.get("/", (_, res) => res.send("Bot is Online"));
app.listen(8080, () => console.log("🚀 Server running on port 8080"));
