// ========================================
// STC Chatbot - index.js (PART 1: SETUP & SCHEMA)
// ========================================

const axios = require("axios"); // เพิ่ม axios ตรงนี้ด้วยครับเพราะต้องใช้ดึงข่าว
const cheerio = require("cheerio");
const mongoose = require("mongoose");
const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
const cron = require("node-cron"); // เพิ่ม cron ตรงนี้เพื่อใช้รันข่าวอัตโนมัติ
require("moment/locale/th");

moment.locale('th');

const collegeData = require("./collegeData");
const officialFacts = require("./officialFacts");
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("🍃 Connected to MongoDB"))
  .catch(err => {
    console.error("❌ MongoDB Error:", err);
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
    detail: String,
    imageUrl: String, // เพิ่ม: เพื่อรองรับการเก็บรูปแจ้งปัญหา
    step: String      // เพิ่ม: เพื่อจำว่าแจ้งปัญหาถึงขั้นตอนไหน
  }
});

const User = mongoose.model("User", userSchema);

const systemStatusSchema = new mongoose.Schema({
    key: { type: String, default: "last_news_id" },
    value: String
});
const SystemStatus = mongoose.model("SystemStatus", systemStatusSchema);

const nameStatsSchema = new mongoose.Schema({
  type: { type: String, enum: ['real', 'nick'], required: true },
  name: { type: String, required: true },
  count: { type: Number, default: 1 }
});
const NameStat = mongoose.model("NameStat", nameStatsSchema);

// --- [ ส่วนที่เพิ่มใหม่เพื่อเป้าหมาย ลดเข้มงวด + กันสแปม ] ---

// ระบบกันสแปม (Anti-Spam Helper)
const userLastMessageTime = new Map();
function isSpam(userId) {
    const now = Date.now();
    const lastTime = userLastMessageTime.get(userId) || 0;
    if ((now - lastTime) < 800) return true; // ถ้าส่งเร็วเกิน 0.8 วินาที ถือว่าเป็นสแปม
    userLastMessageTime.set(userId, now);
    return false;
}

// รายชื่อสาขา
const DEPARTMENTS = [
    "ช่างยนต์", "ช่างไฟฟ้ากำลัง", "ช่างอิเล็กทรอนิกส์", 
    "ช่างกลโรงงาน", "ช่างก่อสร้าง", "ช่างเชื่อมโลหะ", 
    "การบัญชี", "การตลาด", "เทคโนโลยีสารสนเทศ", "IT", 
    "คอมพิวเตอร์กราฟิก", "การจัดการโลจิสติกส์", "ช่างอากาศยาน", "ไอที"
];

// ========================================
// FILE STORAGE (ระบบสถิติชื่อ - Backup File)
// ========================================
const NAME_STATS_FILE = "./name_stats.json";
let nameStats = { real: {}, nick: {} };

// โหลดข้อมูลสถิติจากไฟล์ (ถ้ามี)
const loadData = () => {
    try {
        if (fs.existsSync(NAME_STATS_FILE)) {
            const statsData = fs.readFileSync(NAME_STATS_FILE, "utf8");
            // ป้องกันไฟล์ว่างเปล่า (Empty string)
            if (statsData.trim()) {
                nameStats = JSON.parse(statsData);
            }
        }
        // ตรวจสอบโครงสร้างให้แน่ใจว่าไม่พัง
        if (!nameStats.real) nameStats.real = {};
        if (!nameStats.nick) nameStats.nick = {};
    } catch (e) {
        console.error("❌ Error loading data:", e);
        nameStats = { real: {}, nick: {} };
    }
};
loadData();

// บันทึกสถิติลงไฟล์
const saveStats = () => {
    try {
        // กฎทอง: ต้องมั่นใจว่าข้อมูลไม่หายก่อนเขียนทับ
        if (nameStats && (nameStats.real || nameStats.nick)) {
            fs.writeFileSync(NAME_STATS_FILE, JSON.stringify(nameStats, null, 2), "utf8");
        }
    } catch (e) {
        console.error("❌ Save Stats Error:", e);
    }
};

// ฟังก์ชันสำหรับบันทึกลงทั้ง MongoDB และ File (เพื่อให้ข้อมูลอยู่ครบ 100%)
const updateNameStats = async (type, name) => {
    try {
        if (!name) return;

        // 1. ตัดคำนำหน้าชื่อออก (นาย, นางสาว, นาง, เด็กชาย, เด็กหญิง ฯลฯ) เพื่อให้สถิติไม่ซ้ำซ้อน
        const cleanName = name.replace(/^(นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.)/g, "").trim();
        
        // 2. บันทึกลงหน่วยความจำและไฟล์ (ใช้ cleanName)
        const category = type === 'real' ? 'real' : 'nick';
        nameStats[category][cleanName] = (nameStats[category][cleanName] || 0) + 1;
        saveStats();

        // 3. บันทึกลง MongoDB (ใช้ cleanName)
        await NameStat.findOneAndUpdate(
            { type, name: cleanName }, 
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );
    } catch (err) {
        console.error("❌ Update Name Stats Error:", err);
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
// UTIL (VALIDATION - EXTREME HARDENED & RELAXED VERSION)
// ========================================

// --- 1. CONSTANTS ---
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
    /ค.{0,1}ว.{0,1}ย/,        
    /เ.{0,1}ห.{0,1}ี.{0,1}้.{0,1}ย/,      
    /ส.{0,1}ั.{0,1}ส/,          
    /[เแ].{0,1}ย.{0,1}็.{0,1}ด/,            
    /ม.{0,1}ึ.{0,1}ง/, 
    /ก.{0,1}ู/,
    /f.{0,1}u.{0,1}c.{0,1}k/i, 
    /s.{0,1}h.{0,1}i.{0,1}t/i
];

// --- 2. CORE FUNCTIONS ---

function hardenText(text) {
    if (!text) return "";
    return text.toLowerCase()
        .replace(/\s+/g, "") // ลบช่องว่าง
        .replace(/[^ก-์a-zA-Z0-9]/g, ""); // ลบอักขระพิเศษ แต่เก็บสระและวรรณยุกต์ไว้เช็คบริบท
}

function isExtremelyBad(text) {
    if (!text) return false;
    
    // กฎเหล็ก: ถ้ามีแค่พยัญชนะ 1-2 ตัว (ไม่นับสระ/วรรณยุกต์) ให้ปล่อยผ่านทันที
    // เช่น "เคเค" มีพยัญชนะแค่ "ค" กับ "ค" = 2 ตัว -> ผ่าน
    const consonantsOnly = text.replace(/[^ก-ฮa-zA-Z]/g, "");
    if (consonantsOnly.length <= 2) return false;

    const clean = hardenText(text);
    
    // ตรวจสอบ Whitelist (คงเดิม)
    const whiteList = ["สวัสดี", "หวัดดี", "ขอบคุณ", "ครับ", "ค่ะ", "วิทยาลัย"];
    if (whiteList.some(word => clean.includes(hardenText(word)))) return false; 

    // เช็ค Blacklist และ Patterns
    if (BLACKLIST_WORDS.some(word => clean.includes(word))) return true;
    if (EXTREME_BAD_PATTERNS.some(pattern => pattern.test(clean))) return true;

    return false;
}

function isTextSpam(text) {
    if (!text) return false;
    
    // 1. ดักจับการพิมพ์สัญลักษณ์พิเศษซ้ำๆ (เช่น !!!!!!! หรือ ?????)
    if (/^[!?@#\$%\^&\*\(\)\+=\-_.]{3,}$/.test(text)) return true;
    
    // 2. ดักจับตัวอักษรซ้ำๆ (เช่น กกกกกกก)
    if (/(.)\1{4,}/.test(text)) return true; 
    
    return false;
}

/**
 * ฟังก์ชันหลักสำหรับดักจับประเภทข้อความ (ใช้ใน handleEvent ส่วนที่ 8)
 */
function detectMessageType(text) {
    // เช็คสแปมก่อน เพราะสแปมมักจะเป็นสัญลักษณ์
    if (isTextSpam(text)) return "spam";
    
    // เช็คคำหยาบ (ซึ่งตอนนี้เรามีกฎปล่อยผ่านคำสั้น 2 ตัวแล้ว)
    if (isExtremelyBad(text)) return "badword";
    
    return "normal";
}

// --- 3. REGISTRATION HELPERS ---

function containsBadWord(text) {
    return isExtremelyBad(text);
}

function isForbidden(t) {
    if (!t) return false;
    return FORBIDDEN_NAMES.includes(t.toLowerCase());
}

/**
 * ตรวจสอบชื่อจริง (รองรับไทย-อังกฤษ และอักขระพิเศษบางตัว)
 */
function isStrictlyHumanName(text) {
    if (!text || text.length < 2 || text.length > 50) return false;
    if (isTextSpam(text) || containsBadWord(text)) return false;
    
    // Regex รองรับภาษาไทย สระ วรรณยุกต์ และช่องว่าง
    if (!/^[a-zA-Zก-์\s.]+$/.test(text)) return false;

    // ต้องมีพยัญชนะอย่างน้อย 1 ตัว
    return /[ก-ฮa-zA-Z]/.test(text);
}

/**
 * ฟังก์ชันตรวจสอบชื่อทั่วไป/ชื่อเล่น (ใช้ใน handleEvent ส่วนที่ 8)
 */
function isHumanName(text, min = 1, max = 20) {
    if (!text || text.length < min || text.length > max) return false;
    if (containsBadWord(text)) return false;
    return isStrictlyHumanName(text);
}

function isLikelyNickname(text) {
    if (!text) return false;
    return text.length <= 10; 
}

/**
 * ตรวจสอบว่าใส่ชื่อจริงกับชื่อเล่นสลับกันหรือไม่ (Option เสริม)
 */
function looksSwapped(realName, nickName) {
    if (!realName || !nickName) return false;
    // ถ้าชื่อเล่นยาวกว่าชื่อจริงมากๆ มีโอกาสสลับกัน
    return nickName.length > realName.length + 5;
}

// ========================================
// HELPERS (ฟังก์ชันสนับสนุนระบบ - COMPLETE VERSION)
// ========================================

/**
 * 1. ฟังก์ชันตอบกลับพื้นฐาน (Reply Message)
 * ใช้สำหรับส่งข้อความตอบกลับไปยังผู้ใช้ทันที
 */
function reply(event, message) {
    return client.replyMessage(event.replyToken, { 
        type: "text", 
        text: message 
    });
}

// 2. ฟังก์ชันเตือนเมื่อใช้คำหยาบ (ดักไว้ 3 ครั้ง - ปรับเวลาบล็อกเป็น 3 นาที)
async function increaseWarning(user) {
    try {
        const now = moment().tz("Asia/Bangkok");

        // 🚩 จุดที่ต้องเพิ่ม: ถ้าเวลาแบนหมดไปแล้ว (พ้นโทษแล้ว) 
        // ให้รีเซ็ต badCount เป็น 0 ก่อนจะเริ่มนับครั้งใหม่
        if (user.blockedUntil && now.isAfter(moment(user.blockedUntil))) {
            user.badCount = 0;
            user.blockedUntil = undefined; // ล้างเวลาแบนเดิมทิ้งด้วย
        }

        // เพิ่มตัวนับ (ถ้าพ้นโทษมาจะเป็น 1, ถ้าทำผิดซ้ำจะเป็น 2 หรือ 3)
        user.badCount = (user.badCount || 0) + 1; 
        if (user.badCount >= 3) {
            user.blockedUntil = moment().add(3, 'minutes').toDate(); 
            await user.save();
            return client.pushMessage(user.userId, {
                type: "text",
                text: "🚫 คุณถูกระงับการใช้งานเป็นเวลา 3 นาที เนื่องจากละเมิดกฎการใช้งานครบ 3 ครั้งครับ"
            });
        }
        
        await user.save();
        return client.pushMessage(user.userId, {
            type: "text",
            text: `⚠️ คำเตือน (ครั้งที่ ${user.badCount}/3): ระบบตรวจพบข้อความไม่เหมาะสม หากครบ 3 ครั้งจะถูกระงับการใช้งานชั่วคราวนะครับ`
        });
    } catch (err) {
        console.error("Warning Error:", err);
    }
}

/**
 * 3. ฟังก์ชันดึงเนื้อหาจาก LINE Server (Download Content)
 * ใช้สำหรับดาวน์โหลดรูปภาพ เพื่อนำไปใช้ในระบบแจ้งปัญหา และ AI Vision วิเคราะห์ภาพ
 */
async function downloadContent(messageId) {
    try {
        const stream = await client.getMessageContent(messageId);
        return new Promise((resolve, reject) => {
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("error", (err) => {
                console.error("❌ Download Content Error:", err);
                reject(err);
            });
            stream.on("end", () => resolve(Buffer.concat(chunks)));
        });
    } catch (err) {
        console.error("❌ getMessageContent Error:", err);
        throw err;
    }
}

// ========================================
// NEWS SYNC (ระบบแจ้งข่าวสารวิทยาลัยอัตโนมัติ - REINFORCED)
// ========================================

// ตัวแปรสำหรับ AI อ้างอิง (Initialize ไว้ก่อนกันพัง)
global.latestNewsTitle = "กำลังติดตามข่าวสาร...";
global.latestNewsLink = "https://www.sptc.ac.th";
global.latestNewsDate = "";

async function checkCollegeNews() {
    try {
        console.log("📡 เริ่มตรวจสอบข่าววิทยาลัย...");
        const response = await axios.get("https://www.sptc.ac.th/home/", {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            timeout: 15000 
        });

        const $ = cheerio.load(response.data);
        const firstPost = $('article').first(); 
        const title = firstPost.find('h2, h3').first().text().trim() || "ข่าวประชาสัมพันธ์วิทยาลัย";
        const link = firstPost.find('a').attr('href');
        let rawImg = firstPost.find('img').attr('data-src') || firstPost.find('img').attr('src');

        if (!link) return;

        // แก้ปัญหา Image URL ไม่สมบูรณ์ (กฎทอง: รูปต้องขึ้น)
        let imageUrl = rawImg;
        if (imageUrl && imageUrl.startsWith('/')) {
            imageUrl = `https://www.sptc.ac.th${imageUrl}`;
        }
        const finalImg = (imageUrl && imageUrl.startsWith('http')) ? imageUrl : "https://www.sptc.ac.th/home/wp-content/uploads/2021/03/logo-sptc.png";

        let savedStatus = await SystemStatus.findOne({ key: "last_news_id" });

        // อัปเดตข้อมูลให้ AI เสมอ
        global.latestNewsTitle = title;
        global.latestNewsLink = link;
        global.latestNewsDate = moment().tz("Asia/Bangkok").format("D MMMM YYYY");

        // ตรวจสอบว่าเป็นข่าวใหม่จริงไหม
        if (!savedStatus || savedStatus.value !== link) {
            console.log(`🆕 พบข่าวใหม่: ${title}`);
            
            await SystemStatus.findOneAndUpdate(
                { key: "last_news_id" },
                { value: link },
                { upsert: true }
            );

            // ส่ง Broadcast หา User ทุกคนที่ติดตามบอท
            await client.broadcast({
                type: "flex",
                altText: `📢 ข่าวใหม่จากวิทยาลัย: ${title}`,
                contents: {
                    type: "bubble",
                    hero: { 
                        type: "image", 
                        url: finalImg, 
                        size: "full", 
                        aspectRatio: "20:13", 
                        aspectMode: "cover" 
                    },
                    body: {
                        type: "box", 
                        layout: "vertical",
                        contents: [
                            { type: "text", text: "📢 ข่าวประชาสัมพันธ์ใหม่", weight: "bold", color: "#e67e22", size: "sm" },
                            { type: "text", text: title, weight: "bold", size: "md", wrap: true, margin: "md" },
                            { type: "text", text: `อัปเดตเมื่อ: ${global.latestNewsDate}`, size: "xs", color: "#aaaaaa", margin: "sm" }
                        ]
                    },
                    footer: {
                        type: "box", 
                        layout: "vertical",
                        contents: [
                            { 
                                type: "button", 
                                action: { type: "uri", label: "อ่านรายละเอียด", uri: link }, 
                                style: "primary", 
                                color: "#2c3e50" 
                            }
                        ]
                    }
                }
            }).catch(e => console.error("❌ Broadcast Failed:", e.message));
        }
    } catch (err) {
        console.error("❌ News Sync Error:", err.message);
    }
}

//=========================================

// ========================================
// WEBHOOK (ช่องทางรับข้อมูลหลักจาก LINE)
// ========================================

app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
        // ตรวจสอบว่ามี Events ส่งมาจริงไหม
        if (!req.body.events || req.body.events.length === 0) {
            return res.json({ status: "ok" });
        }

        // กฎทอง: ประมวลผลทุก Event ที่ส่งมา (เช่น ข้อความ, รูปภาพ, การกดปุ่ม)
        await Promise.all(req.body.events.map(async (event) => {
            
            // ระบบป้องกันสแปมระดับ Gateway (ถ้าส่งรัวเกินไปให้ข้าม Event นั้นทันที)
            const userId = event.source.userId;
            if (userId && typeof isSpam === "function" && isSpam(userId)) {
                console.warn(`🛡️ Anti-Spam: Blocked fast request from ${userId}`);
                return null;
            }

            // ส่งต่อไปยังฟังก์ชันจัดการหลัก
            return handleEvent(event);
        }));

        res.json({ status: "ok" });
    } catch (err) {
        // กฎทอง: ถ้าพังต้องมี Log บอกว่าพังที่ไหน
        console.error("❌ Webhook Error:", err.message);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ========================================
// MAIN LOGIC - handleEvent (ULTIMATE REINFORCED)
// ========================================
async function handleEvent(event) {
    // 1. กรองเฉพาะข้อความและรูปภาพ
    if (event.type !== "message" || !["text", "image"].includes(event.message.type)) return;

    const userId = event.source?.userId;
    if (!userId) return;

    let user = await User.findOne({ userId });

    // 2. สร้าง User ใหม่หากยังไม่มีในระบบ
    if (!user) {
        user = new User({ userId, step: "ask_realname" });
        await user.save();
        return reply(event, "สวัสดีครับ! ก่อนเริ่มคุยมาทำความรู้จักกันก่อนนะครับ 😊\nกรุณาพิมพ์ **ชื่อจริง-นามสกุล** ของคุณเพื่อลงทะเบียนครับ");
    }

    // 3. จัดการกรณีส่ง "รูปภาพ" (แจ้งปัญหา หรือ AI Vision)
    if (event.message.type === "image") {
        return await handleImageMessage(event, user); 
    }

    // 4. เตรียมข้อมูลข้อความ
    const text = event.message.text.trim();
    const lower = text.toLowerCase();
    const now = moment().tz("Asia/Bangkok").locale("th");

    // 5. ระบบตรวจสอบการบล็อก
    if (user.blockedUntil && moment().isBefore(user.blockedUntil)) {
        const diff = moment(user.blockedUntil).diff(now, "seconds");
        return reply(event, `⛔ คุณถูกระงับการใช้งานชั่วคราว\nกรุณารออีก ${diff} วินาทีครับ`);
    }

    // 6. ระบบกรองคำหยาบและสแปม
    const msgType = detectMessageType(text);
    if (msgType === "badword") {
        await increaseWarning(user);
        return; 
    }
    if (msgType === "spam") {
        return reply(event, "⚠️ ระบบตรวจพบข้อความลักษณะสแปม กรุณาพิมพ์ข้อความที่มีความหมายครับ");
    }

    // 7. คำสั่งพิเศษ (เปลี่ยนข้อมูล/รีเซ็ต)
    if (lower.includes("เริ่มใหม่") || lower.includes("ยกเลิก") || lower.includes("ลงทะเบียนใหม่")) {
        user.step = "ask_realname";
        user.realName = undefined; 
        user.nickName = undefined;
        user.age = undefined;
        user.department = undefined;
        user.birthday = undefined;
        user.badCount = 0; 
        await user.save();
        return reply(event, "🤖 รีเซ็ตระบบให้แล้วครับ! \n\nกรุณาพิมพ์ **ชื่อจริง-นามสกุล** ของคุณเพื่อเริ่มใหม่ครับ");
    }
    
    if (lower.includes("เปลี่ยนชื่อเล่น")) { user.step = "ask_nickname_only"; await user.save(); return reply(event, "พิมพ์ **ชื่อเล่นใหม่** ได้เลยครับ"); }
    if (lower.includes("เปลี่ยนชื่อ")) { user.step = "ask_realname_only"; await user.save(); return reply(event, "พิมพ์ **ชื่อจริงใหม่** ได้เลยครับ"); }
    if (lower.includes("เปลี่ยนอายุ")) { user.step = "ask_age_only"; await user.save(); return reply(event, "พิมพ์ **อายุใหม่** ของคุณครับ"); }

    // 8. ระบบแจ้งปัญหาการใช้งาน (REPORT FLOW)
    if (lower === "แจ้งปัญหาการใช้งาน") {
        user.step = "report_title";
        await user.save();
        return reply(event, "📢 ยินดีรับเรื่องครับ\nกรุณาพิมพ์ **หัวข้อปัญหา** ที่ต้องการแจ้งครับ");
    }
    if (user.step === "report_title") {
        user.tempReport = { title: text, step: "report_detail" };
        user.step = "report_detail";
        await user.save();
        return reply(event, "ขอบคุณครับ ต่อไปขอทราบ **รายละเอียดของปัญหา** ครับ");
    }
    if (user.step === "report_detail") {
        if (user.tempReport) user.tempReport.detail = text;
        user.step = "report_photo";
        await user.save();
        return reply(event, "คุณต้องการ **ส่งรูปภาพประกอบ** ไหมครับ? (ส่งรูปมาได้เลย หรือพิมพ์ 'ไม่มี' เพื่อข้าม)");
    }
    if (user.step === "report_photo" && text === "ไม่มี") {
        const summary = `✅ แจ้งเรื่องสำเร็จ!\n📌 หัวข้อ: ${user.tempReport.title}\n👤 ผู้แจ้ง: ${user.realName}`;
        user.step = "done";
        user.tempReport = undefined;
        await user.save();
        return reply(event, summary);
    }

    // 9. REGISTER FLOW (CORE)
    const isRegistered = user.realName && user.nickName && user.age && user.department;

    if (user.step && user.step.startsWith("ask_realname")) {
        if (!isStrictlyHumanName(text)) return reply(event, "❌ กรุณาใช้ชื่อจริงที่ถูกต้อง (ภาษาไทย/อังกฤษ) และสุภาพครับ");
        user.realName = text;
        if (user.step.endsWith("_only") || isRegistered) {
            user.step = "done"; await user.save();
            return reply(event, `✅ เปลี่ยนชื่อจริงเป็น: ${text} เรียบร้อยครับ`);
        }
        user.step = "ask_nickname";
        await user.save();
        updateNameStats('real', text);
        return reply(event, `ยินดีที่ได้รู้จักครับคุณ ${text} 😊\nขอทราบ **ชื่อเล่น** ด้วยครับ`);
    }

    if (user.step && user.step.startsWith("ask_nickname")) {
        if (!isHumanName(text, 1, 15)) return reply(event, "❌ ชื่อเล่นไม่ถูกต้องครับ");
        user.nickName = text;
        if (user.step.endsWith("_only") || isRegistered) {
            user.step = "done"; await user.save();
            return reply(event, `✅ เปลี่ยนชื่อเล่นเป็น: ${text} เรียบร้อยครับ`);
        }
        user.step = "ask_age";
        await user.save();
        updateNameStats('nick', text);
        return reply(event, "บันทึกชื่อเล่นแล้วครับ ต่อไปขอทราบ **อายุ** (เป็นตัวเลข) ครับ");
    }

    if (user.step && user.step.startsWith("ask_age")) {
        const age = parseInt(text);
        if (isNaN(age) || age < 1 || age > 80) return reply(event, "❌ กรุณากรอกอายุเป็นตัวเลข (1-80) ครับ");
        user.age = age;
        if (user.step.endsWith("_only") || isRegistered) {
            user.step = "done"; await user.save();
            return reply(event, `✅ อัปเดตอายุเป็น: ${age} ปี เรียบร้อยครับ`);
        }
        user.step = "ask_birthday";
        await user.save();
        return reply(event, "วันเกิดน้องวันไหนครับ? (เช่น 12/08/2545)\nหรือพิมพ์ 'ข้าม' ก็ได้ครับ");
    }

    if (user.step === "ask_birthday") {
        if (text !== "ข้าม") {
            if (!moment(text, "DD/MM/YYYY", true).isValid()) return reply(event, "❌ รูปแบบผิดครับ (วัน/เดือน/ปี พ.ศ. เช่น 15/01/2548)");
            user.birthday = text;
        }
        user.step = "ask_department";
        await user.save();
        return reply(event, "สุดท้ายแล้ว... น้องอยู่ **แผนกวิชา** อะไรครับ?\n(เช่น ช่างยนต์, ไอที, การบัญชี)");
    }

    if (user.step === "ask_department") {
        const foundDept = DEPARTMENTS.find(d => text.toLowerCase().includes(d.toLowerCase()));
        if (!foundDept) return reply(event, "❌ ไม่พบแผนกนี้ในระบบวิทยาลัยครับ ลองพิมพ์ใหม่อีกครั้งนะ");
        user.department = foundDept;
        user.step = "done";
        await user.save();
        return reply(event, `🎉 ลงทะเบียนสำเร็จ!\nยินดีต้อนรับน้อง ${user.nickName} แผนก ${user.department} เข้าสู่ระบบครับ`);
    }

    // 10. MULTI INTENT (ปรับปรุงให้ตอบได้หลายอย่างพร้อมกัน)
    let answers = []; // สร้างตัวแปรเก็บคำตอบ

    // เช็คเรื่องเวลา
    if (lower.includes("กี่โมง") || lower.includes("เวลา")) {
        answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น. ครับน้อง ${user.nickName}`);
    }

    // เช็คเรื่องวันที่
    if (lower.includes("วันที่") || lower.includes("วันอะไร")) {
        answers.push(`📅 วันนี้คือ${now.format("ddddที่ D MMMM YYYY")} ครับ`);
    }

    // เช็คปี พ.ศ.
    if (lower.includes("ปีอะไร")) {
        answers.push(`🗓 ปีนี้คือปี พ.ศ. ${now.year() + 543} ครับ`);
    }

    // ถ้ามีการเก็บคำตอบไว้ใน Array ให้ส่งคำตอบทั้งหมดออกไปพร้อมกัน
    if (answers.length > 0) {
        return reply(event, answers.join("\n")); // เชื่อมคำตอบด้วยการขึ้นบรรทัดใหม่
    }
    if (lower === "/topname") {
        const topReals = await NameStat.find({type:'real'}).sort({count:-1}).limit(3);
        const resMsg = `📊 ชื่อยอดนิยมในระบบ:\n${topReals.map(n => `- ${n.name} (${n.count} คน)`).join('\n')}`;
        return reply(event, resMsg);
    }

    if (lower.includes("ข่าว")) {
        const newsList = await getLatestNews(2);
        if (newsList && newsList.length > 0) {
            let selectedNews = newsList[0];
            let typeText = "ล่าสุด! 🔥";
            
            // เพิ่มการดักจับคำว่า "เก่า" และ "ย้อนหลัง"
            if (lower.includes("เมื่อวาน") || lower.includes("ก่อนหน้า") || lower.includes("เก่า") || lower.includes("ย้อนหลัง")) {
                if (newsList.length > 1) { 
                    selectedNews = newsList[1]; 
                    typeText = "ข่าวก่อนหน้า 📰"; 
                }
            }
            return reply(event, `📢 **ข่าวประชาสัมพันธ์** (${typeText})\nเรื่อง: ${selectedNews.title}\n🔗 อ่านต่อ: ${selectedNews.link}`);
        } else if (global.latestNewsTitle) {
            return reply(event, `📢 **ข่าวประชาสัมพันธ์** (ล่าสุด)\nเรื่อง: ${global.latestNewsTitle}\n🔗 อ่านต่อ: ${global.latestNewsLink}`);
        }
        return reply(event, "📢 ขออภัยครับ ไม่สามารถดึงข่าวได้ในขณะนี้");
    }

    if (lower.includes("ปีใหม่") && (lower.includes("อีกกี่วัน") || lower.includes("เหลืออีก"))) {
        const nextYear = now.year() + 1;
        const newYearDate = moment.tz(`${nextYear}-01-01 00:00:00`, "YYYY-MM-DD HH:mm:ss", "Asia/Bangkok");
        const daysLeft = newYearDate.diff(now, 'days');
        const hoursLeft = newYearDate.diff(now, 'hours') % 24;
        return reply(event, `🎆 นับถอยหลังสู่ปีใหม่ ${nextYear}!\n\n🗓 อีกประมาณ **${daysLeft} วัน ${hoursLeft} ชั่วโมง** จะถึงวันขึ้นปีใหม่ครับ!✨`);
    }

    // 11. AI FALLBACK (GPT-4o-mini)
if (user.step === "done") {
    try {
        const dateStr = now.format("LLLL"); 
        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `คุณคือ "พี่บอท SPTC" ที่ปรึกษาผู้ใจดีจากวิทยาลัยเทคนิคสมุทรปราการ
                    [ข้อมูลผู้ใช้]
                    - ชื่อจริง: ${user.realName || "ไม่ระบุ"}
                    - ชื่อเล่น: ${user.nickName || "น้อง"}
                    - อายุ: ${user.age || "ไม่ระบุ"} ปี
                    - แผนก: ${user.department || "ไม่ระบุ"}
                    - วันเกิด: ${user.birthday || "ไม่ได้ลงทะเบียนไว้"}
                    [บริบทสำคัญ]
                    - วันนี้คือ: ${dateStr}
                    - ข่าวล่าสุด: ${global.latestNewsTitle || "ไม่มีข่าวใหม่"}
                    - ข้อมูลวิทยาลัย: ${JSON.stringify(collegeData)}
                    - ข้อมูลอ้างอิงอื่นๆ (นายก/จังหวัด): ${JSON.stringify(officialFacts)} 
                    [แนวทางการตอบ]
                    1. แทนตัวเองว่า "พี่บอท" 2. ใช้ข้อมูลจาก [ข้อมูลอ้างอิงอื่นๆ] ในการตอบคำถามทั่วไป 3. ตอบสุภาพมีหางเสียง` 
                },
                { role: "user", content: text }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return reply(event, aiResponse.choices[0].message.content);
    } catch (e) {
        console.error("AI Error:", e);
        return reply(event, `ขออภัยครับน้อง ${user.nickName} พี่บอทมึนหัวนิดหน่อย รบกวนถามใหม่อีกครั้งนะ 🤖`);
    }
}
} // ปิด handleEvent เรียบร้อย

// ========================================
// IMAGE PROCESSING FUNCTION (AI VISION & REPORT)
// ========================================
async function handleImageMessage(event, user) {
    try {
        // 1. ตรวจสอบสิทธิ์การส่งรูป
        if (!user || (user.step !== "done" && user.step !== "report_photo")) {
            return reply(event, "⚠️ พี่บอทยังไม่รู้จักน้องเลย กรุณาลงทะเบียนให้เสร็จก่อนส่งรูปภาพนะครับ");
        }

        // 2. ตรวจสอบที่มาของรูปภาพ
        if (event.message.contentProvider.type !== "line") {
            return reply(event, "❌ ขออภัยครับ พี่บอทไม่สามารถประมวลผลรูปภาพจากแหล่งภายนอกได้");
        }

        // 3. ดึงรูปภาพจาก LINE Server (ใช้ Helper จากส่วนที่ 5)
        const buffer = await downloadContent(event.message.id);
        const base64Image = buffer.toString("base64");

        // --- กรณีที่ 1: ส่งรูปเพื่อแจ้งปัญหาการใช้งาน ---
        if (user.step === "report_photo") {
            // ในทางปฏิบัติควร Upload ขึ้น Cloud Storage แต่ในที่นี้เราบันทึกสถานะว่าได้รับแล้ว
            const successMsg = `✅ ได้รับรูปภาพประกอบแล้ว!\n\n` +
                               `📌 หัวข้อ: ${user.tempReport?.title || "ไม่ระบุ"}\n` +
                               `📝 รายละเอียด: ${user.tempReport?.detail || "ไม่ระบุ"}\n` +
                               `👤 ผู้แจ้ง: ${user.realName} (แผนก ${user.department})\n\n` +
                               `พี่บอทส่งเรื่องให้เจ้าหน้าที่ตรวจสอบเรียบร้อยแล้วครับ ขอบคุณครับ 🙏`;
            
            // ล้างข้อมูลชั่วคราวและเปลี่ยนสถานะเป็น Done
            user.step = "done";
            user.tempReport = undefined; 
            await user.save();

            return reply(event, successMsg);
        }

        // --- กรณีที่ 2: ส่งรูปมาคุยกับ AI (Vision Mode) ---
        if (user.step === "done") {
            // แจ้งเตือน User ก่อนเพราะ Vision ใช้เวลาประมวลผล 3-7 วินาที
            await client.replyMessage(event.replyToken, { 
                type: "text", 
                text: "🤖 พี่บอทได้รับรูปแล้วครับ กำลังใช้สายตา AI วิเคราะห์สักครู่นะ..." 
            });

            // ส่งรูปให้ OpenAI วิเคราะห์
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: [
                            { 
                                type: "text", 
                                text: `วิเคราะห์รูปภาพนี้อย่างสุภาพในฐานะ 'พี่บอท' ผู้ช่วยวิทยาลัย SPTC ให้กับนักเรียนชื่อ ${user.nickName} แผนก ${user.department} (หากเป็นรูปของกิน, สถานที่ หรือสิ่งของ ให้ทักทายอย่างเป็นกันเอง)` 
                            },
                            { 
                                type: "image_url", 
                                image_url: { url: `data:image/jpeg;base64,${base64Image}` } 
                            },
                        ],
                    },
                ],
                max_tokens: 500,
            });

            const aiVisionReply = response.choices[0].message.content;

            // ใช้ Push Message ป้องกัน Reply Token Expired
            return client.pushMessage(user.userId, { 
                type: "text", 
                text: "🔍 ผลการวิเคราะห์จากพี่บอท:\n\n" + aiVisionReply 
            });
        }
    } catch (err) {
        console.error("❌ Image Processing Error:", err);
        // กรณีเกิด Error ระหว่างประมวลผล
        const errorMsg = err.message.includes("limit") 
            ? "❌ ขออภัยครับ รูปภาพมีขนาดใหญ่เกินไป" 
            : "❌ พี่บอทตามัวชั่วคราว ไม่สามารถมองเห็นรูปนี้ได้ครับ";
            
        return client.pushMessage(user.userId, { type: "text", text: errorMsg });
    }
}

// ========================================
// INITIALIZATION & CRON JOBS (ระบบทำงานอัตโนมัติ)
// ========================================

/**
 * ฟังก์ชันดึงข่าว (แนะนำให้วางไว้ก่อน initGlobalStats)
 * ใช้สำหรับดึงข้อมูลข่าวแบบ Real-time เมื่อมีคนถามบอท
 */
async function getLatestNews(limit = 2) {
    try {
        const response = await axios.get("https://www.sptc.ac.th/home/", {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(response.data);
        const news = [];
        
        // ปรับ Selector ให้ตรงกับโครงสร้างเว็บ SPTC ปัจจุบัน
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
        console.error("❌ News Fetch Error:", err.message);
        return [];
    }
}

/**
 * ฟังก์ชันเตรียมระบบเมื่อรันบอทครั้งแรก
 */
async function initGlobalStats() {
    try {
        console.log("📦 ระบบกำลังเริ่มทำงาน (Initialization)...");
        
        // 1. ดึงสถานะข่าวล่าสุดจากฐานข้อมูล
        const savedStatus = await SystemStatus.findOne({ key: "last_news_id" });
        
        // 2. รันตรวจสอบข่าวหน้าเว็บทันที เพื่อโหลดข้อมูลเข้า Global Variable ให้ AI ใช้
        await checkCollegeNews(); 
        
        if (savedStatus) {
            console.log(`✅ โหลดสถานะข่าวล่าสุดสำเร็จ: ${savedStatus.value}`);
        }
    } catch (err) {
        console.error("❌ Init Error:", err);
    }
}

// --- เริ่มการทำงาน ---

const PORT = process.env.PORT || 10000;

// 2. รวม Route สำหรับหน้าแรกและการเช็คสถานะ
app.get("/", (req, res) => {
    res.send(`🤖 SPTC Bot is Online and Ready! (Started at: ${moment().tz("Asia/Bangkok").format("HH:mm:ss")})`);
});

app.get("/keepalive", (req, res) => {
    res.send("I'm alive!");
});

// ... (โค้ดส่วนก่อนหน้า)

// 3. เริ่มรัน Server เพียงตัวเดียว
app.listen(PORT, () => {
    console.log(`🚀 SPTC Chatbot is running on port ${PORT}`);
    initGlobalStats(); 
});

// 4. ตั้งเวลาตรวจสอบข่าวหน้าเว็บทุก 30 นาที (Cron Job)
cron.schedule("*/30 * * * *", () => {
    console.log("⏰ Cron: กำลังตรวจสอบข่าวใหม่จากวิทยาลัย...");
    checkCollegeNews();
});
// ========================================
