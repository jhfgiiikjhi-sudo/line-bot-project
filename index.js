// ========================================
// STC Chatbot - index.js (ULTIMATE FINAL COMPLETE)
// ========================================

const cheerio = require("cheerio");
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
  .then(() => console.log("🍃 Connected to MongoDB"))
  .catch(err => {
    console.error("❌ MongoDB Error:", err);
    // ไม่ต้องทำอะไร เดี๋ยว Mongoose จะพยายาม Reconnect เองตาม default
  });

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

// เก็บสถานะระบบ (เช่น ID ข่าวล่าสุด)
const systemStatusSchema = new mongoose.Schema({
    key: { type: String, default: "last_news_id" },
    value: String
});
const SystemStatus = mongoose.model("SystemStatus", systemStatusSchema);

// เพิ่ม Schema ต่อจาก SystemStatus
const nameStatsSchema = new mongoose.Schema({
  type: { type: String, enum: ['real', 'nick'], required: true },
  name: { type: String, required: true },
  count: { type: Number, default: 1 }
});
const NameStat = mongoose.model("NameStat", nameStatsSchema);

// รายชื่อสาขา
const DEPARTMENTS = [
    "ช่างยนต์", "ช่างไฟฟ้ากำลัง", "ช่างอิเล็กทรอนิกส์", 
    "ช่างกลโรงงาน", "ช่างก่อสร้าง", "ช่างเชื่อมโลหะ", 
    "การบัญชี", "การตลาด", "เทคโนโลยีสารสนเทศ", "IT", 
    "คอมพิวเตอร์กราฟิก", "การจัดการโลจิสติกส์", "ช่างอากาศยาน", "ไอที"
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
// UTIL (VALIDATION - EXTREME HARDENED VERSION)
// ========================================

// --- 1. CONSTANTS (รวมศูนย์ตัวแปรทั้งหมดไว้ที่นี่) ---

const FORBIDDEN_NAMES = [
    "สวัสดี","หวัดดี","ขอบคุณ","ครับ","ค่ะ","ดีครับ","ดีค่ะ",
    "hello","hi","hey","ok","okay","test","ทดสอบ",
    "admin","user","bot","system"
];

const BLACKLIST_WORDS = [
    "ควย", "เย็ด", "เหี้ย", "สัส", "หี", "แตด", "มึง", "กู", 
    "ดอกทอง", "กะหรี่", "ระยำ", "ชิบหาย",
    "fuck", "shit", "bitch", "pussy", "dick", "cunt", "kuy", "yed"
];

const EXTREME_BAD_PATTERNS = [
    // ดักภาษาไทย: ตรวจพยัญชนะหลัก + อะไรก็ได้ที่คั่นกลาง
    /[คข].*[วภ].*[ยญ]/,        // ค*ว*ย
    /[เหเ].*ี.*้.*ย/,           // เ*ี*้ย
    /[สส].*ั.*[สส]/,           // ส*ั*ส
    /ห.*ี/,                    // ห*ี
    /[เยเ].*็.*ด/,             // เ*ย*็*ด
    /ก.*ู.*ม.*ึ.*ง/,           // กรู มึง
    /ด.*อ.*ก.*ท.*อ.*ง/,        // ดอกทอง
    /ช.*ิ.*บ.*ห.*า.*ย/,        // ชิบหาย
    /แ.*ต.*ด/,                 // แตด
    /ระ.*ย.*ำ/,                // ระยำ

    // ดักภาษาอังกฤษ: ดักการลากเสียงและสัญลักษณ์คั่น
    /f.*u.*c.*k/i, 
    /s.*h.*i.*t/i, 
    /b.*i.*t.*c.*h/i, 
    /a.*s.*s/i, 
    /p.*u.*s.*s.*y/i,
    /d.*i.*c.*k/i,
    /c.*u.*m/i
];

// --- 2. CORE FUNCTIONS (ฟังก์ชันการทำงานหลัก) ---

/**
 * ล้างข้อมูลข้อความ (Normalization) 
 * แปลงตัวเลขคล้ายตัวอักษร ลบช่องว่าง และอักขระพิเศษ
 */
function hardenText(text) {
    if (!text) return "";
    return text.toLowerCase()
        .replace(/\s+/g, "") 
        .replace(/[0๑]/g, "o").replace(/[1๑]/g, "i").replace(/[3๓]/g, "e")
        .replace(/[4๔]/g, "a").replace(/[5๕]/g, "s").replace(/[7๗]/g, "t")
        .replace(/[^ก-๙a-zA-Z0-9]/g, ""); 
}

/**
 * ตรวจสอบคำหยาบขั้นรุนแรง (3 ชั้น)
 */
function isExtremelyBad(text) {
    if (!text) return false;
    const clean = hardenText(text);
    
    // 🛑 ยกเว้นคำสุภาพก่อน (White-list) เพื่อไม่ให้ระบบมองว่าเป็นคำหยาบ
    const whiteList = ["สวัสดี", "หวัดดี", "ขอบคุณ", "ครับ", "ค่ะ", "ดีครับ", "ดีค่ะ"];
    if (whiteList.some(word => clean.includes(hardenText(word)))) {
        return false; 
    }

    // ชั้นที่ 1: Check Blacklist
    if (BLACKLIST_WORDS.some(word => clean.includes(word))) return true;

    // ชั้นที่ 2: Check Regex Patterns (ดักคำลากเสียง/เติมจุด)
    if (EXTREME_BAD_PATTERNS.some(pattern => pattern.test(clean))) return true;

    // ชั้นที่ 3: ดักพยัญชนะด่าล้วนๆ (Keyboard Smash)
    // ปรับให้ดักแม่นยำขึ้น ไม่ให้โดนคำทั่วไป
    const rudeSmash = /^[ควยเหี้ยสัสกม]+$/;
    if (clean.length >= 2 && rudeSmash.test(clean)) {
        // เช็คอีกทีว่าไม่ใช่คำทั่วไปที่อาจจะเหลือแค่พยัญชนะเหล่านี้
        return true;
    }

    return false;
}

/**
 * ตรวจสอบสแปมและการพิมพ์ซ้ำซ้อน
 */
function isSpam(text) {
    if (!text) return false;
    // ดักการพิมพ์สัญลักษณ์รัวๆ
    if (/^[!?@#\$%\^&\*\(\)\+=\-_.]{3,}$/.test(text)) return true;
    // ดักการพิมพ์ตัวอักษรซ้ำเกิน 4 ตัว
    if (/(.)\1{4,}/.test(text)) return true;
    return false;
}

/**
 * ตรวจสอบประเภทข้อความเพื่อใช้ในระบบ Filter หลัก
 */
function detectMessageType(text) {
    if (!text) return "normal";
    // ยกเว้นตัวเลขล้วน (เช่น อายุ) หรือ รูปแบบวันที่
    if (/^\d+$/.test(text)) return "normal"; 
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "normal";
    
    if (isExtremelyBad(text)) return "badword";
    if (!/[ก-๙a-z0-9]/i.test(text) || isSpam(text)) return "spam";
    
    return "normal";
}

// --- 3. REGISTRATION HELPERS (ฟังก์ชันช่วยตรวจสอบการลงทะเบียน) ---

function containsBadWord(text) {
    return isExtremelyBad(text);
}

function isForbidden(t) {
    if (!t) return false;
    return FORBIDDEN_NAMES.includes(t.toLowerCase());
}

function isStrictlyHumanName(text) {
    if (!text || text.length < 2 || text.length > 50) return false; // ปรับความยาว
    if (isSpam(text) || containsBadWord(text)) return false;
    
    // ปรับ Regex ให้รองรับช่องว่าง (สำหรับนามสกุล)
    if (!/^[a-zA-Zก-๙\s]+$/.test(text)) return false;

    const hasThaiVowel = /[ะาิีึืุูเแโใไำั็]/.test(text);
    // ถ้าเป็นภาษาไทย และยาวกว่า 3 ตัว ควรมีสระ
    if (/[ก-ฮ]/.test(text) && text.length > 3 && !hasThaiVowel && !text.includes("์")) return false;
    
    return true;
}

function isHumanName(text, min, max) {
    if (!text) return false;
    const validThaiEng = /^[ก-๙a-zA-Z]+$/.test(text) && text.length >= min && text.length <= max;
    if (!validThaiEng) return false;
    if (isForbidden(text) || isSpam(text) || containsBadWord(text)) return false;
    
    // ต้องมีสระประกอบ
    if (/^[ก-ฮ]+$/.test(text) && !/[ะาิีึืุูเแโใไำั็]/.test(text)) return false;
    if (/^[a-zA-Z]+$/.test(text) && !/[aeiou]/i.test(text)) return false;
    
    return true;
}

function looksSwapped(real, nick) {
    if (!real || !nick) return false;
    return (nick.length >= real.length + 3) || (real.length <= 3 && nick.length >= 6);
}

function isLikelyNickname(text) {
    if (!text) return false;
    return text.length <= 5; 
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
// NEWS SYNC (ระบบแจ้งข่าวสารวิทยาลัยอัตโนมัติ)
// ========================================
const cron = require("node-cron");
const axios = require("axios");

// เก็บ ID ข่าวล่าสุดที่ส่งไปแล้ว เพื่อไม่ให้ส่งซ้ำ
let lastPostId = null;
async function checkCollegeNews() {
    try {
        console.log("📡 เริ่มตรวจสอบข่าววิทยาลัย...");
        const response = await axios.get("https://www.sptc.ac.th/home/", {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000 // เพิ่ม timeout กันค้าง
        });

        const $ = cheerio.load(response.data);
        const firstPost = $('article').first(); 
        const title = firstPost.find('h2, h3').first().text().trim() || "ข่าวประชาสัมพันธ์";
        const link = firstPost.find('a').attr('href');
        let imageUrl = firstPost.find('img').attr('data-src') || firstPost.find('img').attr('src');

        if (!link) return;

        let savedStatus = await SystemStatus.findOne({ key: "last_news_id" });
        const lastSavedId = savedStatus ? savedStatus.value : null;

        // อัปเดต Global เสมอเพื่อให้ AI มีข้อมูลตอบ
        global.latestNewsTitle = title;
        global.latestNewsLink = link;
        global.latestNewsDate = moment().tz("Asia/Bangkok").format("D MMMM YYYY");

        if (link !== lastSavedId) {
            console.log("🆕 พบข่าวใหม่! กำลังกระจายข่าว...");
            if (!savedStatus) {
                await SystemStatus.create({ key: "last_news_id", value: link });
            } else {
                savedStatus.value = link;
                await savedStatus.save();
            }

            // ส่ง Broadcast
            await client.broadcast({
                type: "flex",
                altText: `📢 ข่าวใหม่: ${title}`,
                contents: {
                    type: "bubble",
                    hero: { 
                        type: "image", url: imageUrl || "https://www.sptc.ac.th/home/wp-content/uploads/2021/03/logo-sptc.png", 
                        size: "full", aspectRatio: "20:13", aspectMode: "cover" 
                    },
                    body: {
                        type: "box", layout: "vertical",
                        contents: [
                            { type: "text", text: "📢 ข่าวประชาสัมพันธ์ใหม่", weight: "bold", color: "#e67e22", size: "sm" },
                            { type: "text", text: title, weight: "bold", size: "md", wrap: true, margin: "md" },
                            { type: "text", text: `อัปเดตเมื่อ: ${global.latestNewsDate}`, size: "xs", color: "#aaaaaa", margin: "sm" }
                        ]
                    },
                    footer: {
                        type: "box", layout: "vertical",
                        contents: [{ type: "button", action: { type: "uri", label: "อ่านรายละเอียด", uri: link }, style: "primary", color: "#2c3e50" }]
                    }
                }
            });
        }
    } catch (err) {
        console.error("❌ News Sync Error:", err.message);
    }
}

//=========================================

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

    // ===== 5. GLOBAL BAD WORD & SPAM FILTER (ULTIMATE VERSION) =====
    const msgType = detectMessageType(text);

    if (msgType === "badword") {
        user.badCount = (user.badCount || 0) + 1;
        
        // ถ้าครบ 3 ครั้ง บล็อกทันทีแล้วหยุดทำงาน (return)
        if (user.badCount >= 3) {
            user.blockedUntil = moment().add(3, "minutes");
            user.badCount = 0; 
            await user.save();
            return reply(event, "⛔ ระบบระงับการใช้งาน 3 นาที\nเนื่องจากคุณใช้คำไม่สุภาพซ้ำหลายครั้ง กรุณาสื่อสารอย่างสร้างสรรค์ครับ");
        }

        // กรณีที่ยังไม่ครบ 3 ครั้ง ให้บันทึกแต้มและส่งคำเตือน
        await user.save();
        await increaseWarning(user); 
        return reply(event, `⚠️ [ระบบป้องกันคำหยาบ] พบข้อความไม่เหมาะสม\nกรุณาใช้ภาษาที่สุภาพในการสื่อสารครับ (เตือนครั้งที่ ${user.badCount}/3)`);
    }

    if (msgType === "spam") {
        return reply(event, "⚠️ ข้อความลักษณะสแปมหรือไม่สื่อความหมาย กรุณาพิมพ์ให้ชัดเจนครับ");
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
    
    const isRegistered = user.realName && user.nickName && user.age && user.department;

    // STEP: ASK REALNAME
    if (user.step && user.step.startsWith("ask_realname")) {
        const isOnly = user.step.endsWith("_only");
        
        if (lower === "ข้าม" && !isOnly) {
            return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้ครับ\nกรุณาพิมพ์ชื่อจริงของคุณเพื่อใช้ในระบบ");
        }

        if (containsBadWord(text)) return reply(event, "❌ กรุณาใช้ชื่อจริงที่สุภาพครับ");
        if (isForbidden(text)) return reply(event, `❌ "${text}" เป็นคำทักทาย ไม่สามารถใช้เป็นชื่อจริงได้ครับ`);
        if (!isStrictlyHumanName(text)) return reply(event, "❌ ดูเหมือนไม่ใช่ชื่อจริงที่ถูกต้องครับ (ใช้ภาษาไทยหรืออังกฤษ)");

        // [แก้ไข] จัดการสถิติชื่อเก่าโดยใช้ Optional Chaining
if (user.realName && nameStats?.real?.[user.realName]) {
    nameStats.real[user.realName] = Math.max(0, nameStats.real[user.realName] - 1);
    if (nameStats.real[user.realName] === 0) delete nameStats.real[user.realName];
}

    user.realName = text;
    // ตรวจสอบความมีอยู่ของ Object ก่อนบันทึกชื่อใหม่
    if (!nameStats.real) nameStats.real = {}; 
    nameStats.real[text] = (nameStats.real[text] || 0) + 1;

        const isRegistered = user.nickName && user.age && user.department;
        
        if (isOnly || isRegistered) {
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

    // [แก้ไข] STEP: ASK DEPARTMENT
    if (user.step === "ask_department") {
        // ค้นหาแบบ Case-insensitive
        const foundDept = DEPARTMENTS.find(d => 
            text.toLowerCase().includes(d.toLowerCase())
        );

        if (!foundDept) {
            return reply(event, `❌ ไม่พบสาขาวิชานี้ในระบบของ SPTC\n\nตัวอย่างสาขา: ช่างยนต์, เทคโนโลยีสารสนเทศ, IT\nกรุณาพิมพ์ชื่อสาขาของคุณใหม่อีกครั้งครับ`);
        }
        
        user.department = foundDept;
        user.step = "done";
        
        try {
            await user.save();
            saveStats();
            return reply(event, `✅ ลงทะเบียนสำเร็จ!\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n⚙️ แผนก ${user.department}\n🎂 อายุ ${user.age} ปี`);
        } catch (err) {
            console.error("Save Error:", err);
            return reply(event, "เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง");
        }
    }

    // STEP: ASK NICKNAME
    if (user.step && user.step.startsWith("ask_nickname")) {
        const isOnly = user.step.endsWith("_only");

        if (containsBadWord(text)) return reply(event, "❌ กรุณาใช้ชื่อที่สุภาพครับ");
        if (isForbidden(text)) return reply(event, `❌ "${text}" เป็นคำทักทายหรือคำทั่วไป ไม่สามารถใช้เป็นชื่อได้ครับ`);
        if (!isHumanName(text, 1, 15)) return reply(event, "❌ รูปแบบชื่อไม่ถูกต้องครับ");
        if (text === user.realName) return reply(event, "⚠️ ชื่อเล่นไม่ควรซ้ำกับชื่อจริงครับ");

        if (!isLikelyNickname(text)) {
            return reply(event, "⚠️ ชื่อเล่นมักจะสั้นกว่านี้นะครับ\nถ้านี่คือชื่อเล่นจริง ๆ ให้พิมพ์ซ้ำอีกครั้งได้เลย 😊");
        }

        if (!isOnly && looksSwapped(user.realName, text)) {
            user.realName = ""; 
            user.step = "ask_realname"; 
            await user.save();
            return reply(event, "⚠️ ดูเหมือนคุณจะใส่ชื่อสลับกันครับ\nกรุณาพิมพ์ **ชื่อจริง** ใหม่อีกครั้งครับ");
        }

        // ... ภายใน if (user.step && user.step.startsWith("ask_nickname")) ...

    // [แก้ไขใหม่] จัดการสถิติชื่อเก่า
    if (user.nickName && nameStats?.nick?.[user.nickName]) {
     nameStats.nick[user.nickName] = Math.max(0, nameStats.nick[user.nickName] - 1);
        if (nameStats.nick[user.nickName] === 0) delete nameStats.nick[user.nickName];
}

    user.nickName = text;
    // เตรียม Object ให้พร้อม
        if (!nameStats.nick) nameStats.nick = {};
        nameStats.nick[text] = (nameStats.nick[text] || 0) + 1;

// ... จากนั้นค่อยบันทึก user.save() และ saveStats() ...

        if (isOnly || isRegistered) {
            user.step = "done";
            await user.save();
            saveStats();
            return reply(event, `✅ เปลี่ยนชื่อเล่นสำเร็จแล้วครับ เป็น: **${text}**`);
        } else {
            user.step = "ask_age";
            await user.save();
            saveStats();
            return reply(event, "บันทึกชื่อเล่นเรียบร้อย! ต่อไปขอทราบ **อายุ** ของคุณครับ 🎂");
        }
    }

    // STEP: ASK AGE
    if (user.step && user.step.startsWith("ask_age")) {
        const ageInput = parseInt(text);
        const isOnly = user.step.endsWith("_only");
        
        if (isNaN(ageInput) || ageInput < 1 || ageInput > 60) {
            return reply(event, "❌ อายุควรเป็นตัวเลข 1-60 ปีครับ");
        }
        
        user.age = ageInput;
        
        if (isOnly || isRegistered) {
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
        
        // ถ้าลงทะเบียนครบแล้วให้จบเลย ถ้ายังไม่ครบให้ไปถามแผนก
        if (isRegistered) {
            user.step = "done";
            await user.save();
            return reply(event, "✅ บันทึกวันเกิดเรียบร้อยครับ!");
        } else {
            user.step = "ask_department"; 
            await user.save();
            return reply(event, `ต่อไปขอทราบ **สาขาวิชา** ของคุณครับ\nตัวอย่าง: ช่างยนต์, เทคโนโลยีสารสนเทศ`);
        }
    }

    // STEP: ASK DEPARTMENT
    if (user.step === "ask_department") {
        // ค้นหาโดยทำให้เป็นตัวเล็กทั้งหมด และรองรับการพิมพ์ชื่อสาขาที่มีคำอื่นปนมา
        const foundDept = DEPARTMENTS.find(d => 
            text.toLowerCase().includes(d.toLowerCase())
        );

        if (!foundDept) {
            return reply(event, `❌ ไม่พบสาขาวิชานี้ในระบบของ SPTC\n\nตัวอย่างสาขา: ช่างยนต์, เทคโนโลยีสารสนเทศ, IT, การบัญชี\nกรุณาพิมพ์ชื่อสาขาของคุณใหม่อีกครั้งครับ`);
        }
        
        // บันทึกค่าโดยใช้ชื่อมาตรฐานจากตัวแปร DEPARTMENTS
        user.department = foundDept;
        user.step = "done";
        
        try {
            await user.save();
            saveStats();
            
            const successMsg = `🎉 ยินดีที่ได้รู้จักครับ!\nลงทะเบียนสำเร็จเรียบร้อย\n\n` +
                               `👤 ชื่อ: ${user.realName}\n` +
                               `🎭 ชื่อเล่น: ${user.nickName}\n` +
                               `⚙️ แผนก: ${user.department}\n` +
                               `🎂 อายุ: ${user.age} ปี\n\n` +
                               `ตอนนี้คุณสามารถคุยกับพี่บอท หรือสอบถามข้อมูลวิทยาลัยได้เลยครับ 🤖`;
            
            return reply(event, successMsg);
        } catch (saveErr) {
            console.error("❌ Save User Error:", saveErr);
            return reply(event, "เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้งครับ");
        }
    }

    // ===== 10. MULTI INTENT (TIME/DATE/AGE/NEWS) =====
    const answers = [];
    const todayStr = now.format("D MMMM YYYY");
    const yesterdayStr = now.clone().subtract(1, 'days').format("D MMMM YYYY");

    // --- เช็คเรื่องเวลา/วันที่ ---
    if (lower.includes("กี่โมง") || lower.includes("เวลา")) answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
    if (lower.includes("วันที่") || lower.includes("วันอะไร")) answers.push(`📅 วันนี้วันที่ ${todayStr}`);
    if (lower.includes("ปีอะไร")) answers.push(`🗓 ปี พ.ศ. ${now.year() + 543}`);

    // --- เช็คเรื่องข่าว (แยก ข่าวล่าสุด / ข่าวเมื่อวาน) ---
    if (lower.includes("ข่าว")) {
        const newsList = await getLatestNews(2); // ดึงมา 2 ข่าวเพื่อเปรียบเทียบ
        
        if (newsList.length > 0) {
            let selectedNews = newsList[0];
            let statusText = "ล่าสุด! 🔥";

            // ถ้าผู้ใช้ระบุว่า "เมื่อวาน" หรือ "ก่อนหน้า" ให้ดึงข่าวลำดับที่ 2
            if (lower.includes("เมื่อวาน") || lower.includes("ก่อนหน้า") || lower.includes("ที่แล้ว")) {
                if (newsList.length > 1) {
                    selectedNews = newsList[1];
                    statusText = "เมื่อวาน/ก่อนหน้านี้ 📰";
                } else {
                    return reply(event, "🤖 ตอนนี้พี่บอทมีข้อมูลแค่ข่าวล่าสุดเพียงอันเดียวครับ");
                }
            }

            return reply(event, `📢 **ข่าวประชาสัมพันธ์** (${statusText})\nเรื่อง: ${selectedNews.title}\n🔗 อ่านต่อ: ${selectedNews.link}`);
        } else {
            return reply(event, "📢 ขณะนี้ยังไม่มีข่าวประชาสัมพันธ์ใหม่จากวิทยาลัยครับ");
        }
    }

    // --- เช็คเรื่องอายุ/วันเกิด ---
    if (lower.includes("อายุ")) answers.push(user.age ? `🎂 คุณอายุ ${user.age} ปีครับ` : "❗ ยังไม่ได้บันทึกอายุ");
    if (lower.includes("วันเกิด")) {
        if (!user.birthday) {
            answers.push("❗ คุณยังไม่ได้บันทึกวันเกิดครับ (พิมพ์ 'เปลี่ยนอายุ' เพื่อตั้งค่าวันเกิด)");
        } else {
            const parts = user.birthday.split("/");
            const d = parseInt(parts[0]), m = parseInt(parts[1]);
            let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
            if (next.isBefore(now, "day")) next.add(1, "year");
            const diff = next.diff(now, "days");
            
            if (diff === 0) {
                answers.push(`🎂 สุขสันต์วันเกิดครับคุณ${user.nickName}! วันนี้คือวันเกิดของคุณพอดีเลย ขอให้มีความสุขมาก ๆ นะครับ 🎉`);
            } else {
                answers.push(`🎂 คุณเกิดวันที่ ${user.birthday} เหลืออีก ${diff} วันจะถึงวันเกิดครับ`);
            }
        }
    }

    if (answers.length > 0) return reply(event, answers.join("\n\n"));
    // ===== EXTRA: NAME INQUIRY =====
        if (lower.includes("ผมชื่อเล่น") || lower.includes("ชื่อเล่นผม")) {
        return reply(event, `🎭 คุณชื่อเล่นว่า **${user.nickName}** ครับ`);
    }
    if (lower.includes("ผมชื่ออะไร") || lower.includes("ชื่อจริงผม")) {
        return reply(event, `👤 คุณชื่อจริงว่า **${user.realName}** ครับ`);
    }
    // ========================================

    // ===== 11. TOP NAME COMMAND =====
    if (lower === "/topname") {
        // [แก้ไข] เพิ่มการเช็ค obj || {} และ Optional Chaining เพื่อความปลอดภัย
        const top = (obj) => {
            if (!obj) return "-";
            const entries = Object.entries(obj);
            if (entries.length === 0) return "-";
            
            return entries
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([n, c]) => `${n} (${c})`)
                .join("\n") || "-";
        };

        const responseMsg = `📊 ชื่อยอดนิยม\n\n` +
                            `🪪 ชื่อจริง:\n${top(nameStats?.real)}\n\n` +
                            `🎭 ชื่อเล่น:\n${top(nameStats?.nick)}`;

        return reply(event, responseMsg);
    }

    // ===== 12. OFFICIAL FACT & USER INFO =====
    if (lower.includes("นายก")) return reply(event, `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`);
    if (lower.includes("ข้อมูลส่วนตัว") || lower.includes("ขอดูข้อมูล")) {
        const userInfo = `📋 **ข้อมูลสมาชิกของคุณ**\n------------------\n👤 ชื่อ: ${user.realName}\n🎭 ชื่อเล่น: ${user.nickName}\n⚙️ แผนก: ${user.department}\n🎂 อายุ: ${user.age} ปี\n📅 วันเกิด: ${user.birthday || "ไม่ได้ระบุ"}\n------------------\n💡 แก้ไขข้อมูลได้โดยพิมพ์: "เปลี่ยนชื่อ" หรือ "เปลี่ยนอายุ"`;
        return reply(event, userInfo);
    }

    // ===== 13. NEW YEAR COUNTDOWN =====
    if (lower.includes("ปีใหม่") && (lower.includes("อีกกี่วัน") || lower.includes("เหลืออีก"))) {
        const now = moment().tz("Asia/Bangkok");
        const nextYear = now.year() + 1;
        const newYearDate = moment.tz(`${nextYear}-01-01 00:00:00`, "YYYY-MM-DD HH:mm:ss", "Asia/Bangkok");
        
        const daysLeft = newYearDate.diff(now, 'days');
        const hoursLeft = newYearDate.diff(now, 'hours') % 24;

        return reply(event, `🎆 นับถอยหลังสู่ปีใหม่ ${nextYear}!\n\n🗓 อีกประมาณ **${daysLeft} วัน ${hoursLeft} ชั่วโมง** จะถึงวันขึ้นปีใหม่ครับ!\n\nเตรียมตัวฉลองกันหรือยังเอ่ย? ✨`);
    }

    // ===== 14. AI FALLBACK (GPT-4o-mini) =====
    try {
        // 1. เตรียม Context ของเวลาและข่าวสาร
        const todayStr = now.format("ddddที่ D MMMM YYYY");
        const newsContext = global.latestNewsTitle 
            ? `หัวข้อ: "${global.latestNewsTitle}"\nวันที่อัปเดต: ${global.latestNewsDate}\nลิงก์: ${global.latestNewsLink}` 
            : "ยังไม่มีข่าวใหม่ในขณะนี้";

        // 2. ปรับจูนบุคลิกและฐานข้อมูลของ AI
        const systemInstruction = `
คุณคือ "พี่บอท SPTC" ผู้ช่วยอัจฉริยะของวิทยาลัยเทคโนโลยีสยามบริหารธุรกิจ (SPTC)
บุคลิก: สุภาพ, เป็นกันเองกับนักเรียน, ใช้คำลงท้าย "ครับ", กระตือรือร้นในการช่วยแก้ปัญหา

ข้อมูลวิทยาลัย: ${JSON.stringify(collegeData)}

กฎเหล็ก:
1. วันนี้คือ${todayStr}
2. บริบทข่าวสารล่าสุด: ${newsContext}
3. หากมีคนถามถึงข่าววันนี้/เมื่อวาน ให้เทียบวันที่ปัจจุบันกับวันที่ของข่าว ถ้าไม่ตรงกันให้บอกข่าวล่าสุดที่มีแทน
4. ใช้ข้อมูลจาก collegeData ในการตอบคำถามเกี่ยวกับสาขา, ที่อยู่, หรือเบอร์โทรศัพท์
5. หากข้อมูลอยู่นอกเหนือจากที่ให้ไว้ ให้แนะนำให้ติดต่อห้องประชาสัมพันธ์หรือแผนกที่เกี่ยวข้องแทน
`;

        const userContext = `คุยกับ: คุณ${user.realName || "นักเรียน"} (ชื่อเล่น: ${user.nickName || "ยังไม่ได้ระบุ"}), แผนก: ${user.department || "ยังไม่ได้ระบุ"}, อายุ: ${user.age || "ยังไม่ได้ระบุ"} ปี`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemInstruction.trim() },
                { role: "system", content: userContext },
                { role: "user", content: text }
            ],
            max_tokens: 450,
            temperature: 0.7, // เพิ่มความลื่นไหลในการสนทนา
        });

        const aiReply = response.choices[0].message.content;
        return reply(event, aiReply);

    } catch (err) {
        console.error("❌ AI Fallback Error:", err.message);
        if (err.message.includes("429")) {
            return reply(event, "ขออภัยครับ ตอนนี้มีผู้ใช้งานจำนวนมาก พี่บอทตอบไม่ทันแล้ว รบกวนลองใหม่อีกครั้งนะครับ 🙏");
        }
        return reply(event, "ขออภัยครับ สมองกลของพี่บอทขัดข้องชั่วคราว กำลังรีบูตระบบใหม่ครับ... 🤖");
    }
} // ปิดฟังก์ชัน handleEvent

// ========================================
// IMAGE PROCESSING FUNCTION
// ========================================
async function handleImageMessage(event, user) {
    try {
        if (!user || (user.step !== "done" && user.step !== "report_photo")) {
            return reply(event, "⚠️ กรุณาลงทะเบียนให้เสร็จก่อนส่งรูปภาพนะครับ");
        }

        // เช็คที่มาของรูปภาพ (ป้องกันกรณีรูปจาก external ที่ไม่ใช่ LINE storage)
        if (event.message.contentProvider.type !== "line") {
            return reply(event, "❌ ขออภัยครับ พี่บอทไม่สามารถประมวลผลรูปภาพจากแหล่งภายนอกได้");
        }

        // ดึงรูปภาพจาก LINE Server
        const stream = await client.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);
        const base64Image = buffer.toString("base64");

        // --- กรณีที่ 1: ส่งรูปเพื่อแจ้งปัญหา ---
        if (user.step === "report_photo") {
            const successMsg = `✅ ได้รับรูปภาพประกอบการแจ้งเรื่องแล้ว!\n\n📌 หัวข้อ: ${user.tempReport?.title || "ไม่ระบุ"}\n📝 รายละเอียด: ${user.tempReport?.detail || "ไม่ระบุ"}\n👤 ผู้แจ้ง: ${user.realName}\n\nพี่บอทส่งเรื่องให้เจ้าหน้าที่ตรวจสอบแล้วครับ ขอบคุณครับ 🙏`;
            
            // ล้างสถานะการแจ้งเรื่อง
            user.step = "done";
            user.tempReport = undefined;
            
            // ส่งข้อความตอบกลับก่อนเพื่อให้ User มั่นใจว่าบอทรับเรื่องแล้ว
            await reply(event, successMsg);
            
            // บันทึก DB เป็นขั้นตอนสุดท้าย
            return await user.save();
        }

        // --- กรณีที่ 2: ส่งรูปมาคุยกับ AI (Vision) ---
        if (user.step === "done") {
            // แจ้ง User ล่วงหน้าเพราะ AI Vision ใช้เวลาประมวลผลนานกว่าข้อความปกติ
            await client.replyMessage(event.replyToken, { type: "text", text: "🤖 พี่บอทได้รับรูปแล้วครับ กำลังวิเคราะห์สักครู่นะ..." });

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: `วิเคราะห์รูปภาพนี้อย่างสุภาพในฐานะ 'พี่บอท' ผู้ช่วยวิทยาลัย SPTC ให้กับนักเรียนชื่อ ${user.nickName} แผนก ${user.department}` },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                    ],
                }],
                max_tokens: 500,
            });

            // ใช้ Push Message เพราะ Reply Token อาจหมดอายุหาก AI ใช้เวลาคิดนานเกินไป
            return client.pushMessage(user.userId, { 
                type: "text", 
                text: "🔍 ผลการวิเคราะห์รูปภาพ:\n\n" + response.choices[0].message.content 
            });
        }
    } catch (err) {
        console.error("❌ AI Vision Error:", err);
        // แจ้งเตือนเมื่อระบบขัดข้อง
        return client.pushMessage(user.userId, { type: "text", text: "❌ ขออภัยครับ พี่บอทไม่สามารถประมวลผลรูปนี้ได้ในขณะนี้" });
    }
}

// ========================================
// INITIALIZATION & CRON JOBS
// ========================================

// ดึงสถานะข่าวล่าสุดจาก DB และรันการตรวจสอบข่าวทันที
async function initGlobalStats() {
    try {
        console.log("📦 ระบบกำลังเริ่มทำงาน (Initialization)...");
        const savedStatus = await SystemStatus.findOne({ key: "last_news_id" });
        
        // รันตรวจสอบข่าวหน้าเว็บทันที 1 ครั้ง เพื่อโหลดข้อมูลเข้า Global Variable
        await checkCollegeNews();
        
        if (savedStatus) {
            console.log(`✅ โหลดสถานะข่าวล่าสุดสำเร็จ: ${savedStatus.value}`);
        }
    } catch (err) {
        console.error("❌ Init Error:", err);
    }
}

// รันฟังก์ชันเตรียมระบบ
initGlobalStats();

// ตั้งเวลาตรวจสอบข่าวหน้าเว็บทุก 30 นาที
cron.schedule("*/30 * * * *", () => {
    checkCollegeNews();
});

// ฟังก์ชันดึงข่าวจากหน้าเว็บ (ปรับปรุงให้ดึงได้หลายข่าว)
async function getLatestNews(limit = 1) {
    try {
        const response = await axios.get("https://www.sptc.ac.th/home/");
        const $ = cheerio.load(response.data);
        const news = [];

        $(".elementor-post__title a").each((i, el) => {
            if (i < limit) {
                news.push({
                    title: $(el).text().trim(),
                    link: $(el).attr("href")
                });
            }
        });
        return news;
    } catch (err) {
        console.error("❌ News Fetch Error:", err);
        return [];
    }
}

// ========================================
// SERVER START
// ========================================
app.get("/", (_, res) => res.send("🤖 SPTC Bot is Online and Ready!"));
app.listen(8080, () => console.log("🚀 Server is running on port 8080"));
