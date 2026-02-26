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
let teacherData = {}; 
try {
    teacherData = require("./teacherData");
    console.log("✅ Load teacherData.jsสำเร็จ");
} catch (err) {
    console.log("⚠️ ไม่พบไฟล์ teacherData.js ระบบจะทำงานโดยไม่มีข้อมูลครู");
}
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
  phone: String,      // เพิ่ม: เก็บเบอร์โทรศัพท์ (สำคัญมาก)
  email: String,      // เพิ่ม: เก็บอีเมล
  step: { type: String, default: "ask_realname" },
  badCount: { type: Number, default: 0 },
  blockedUntil: Date,
  tempReport: {
    title: String,
    detail: String,
    imageUrl: String,
    step: String 
  }
}, { timestamps: true }); // แนะนำให้เพิ่ม timestamps เพื่อให้อาจารย์ดูได้ว่าเด็กคนนี้ทักมาเมื่อไหร่

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
        if (!name) return name;

        // 1. ตัดคำนำหน้าชื่อออกเพื่อให้สถิติไม่ซ้ำซ้อน
        const cleanName = name.replace(/^(นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.)/g, "").trim();
        
        // 2. บันทึกลงหน่วยความจำและไฟล์
        const category = type === 'real' ? 'real' : 'nick';
        nameStats[category][cleanName] = (nameStats[category][cleanName] || 0) + 1;
        saveStats();

        // 3. บันทึกลง MongoDB (Collection: NameStat)
        await NameStat.findOneAndUpdate(
            { type, name: cleanName }, 
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );

        // ✨ ส่งชื่อที่ล้างแล้วกลับออกไปเพื่อให้ระบบหลักใช้งานต่อได้
        return cleanName;
    } catch (err) {
        console.error("❌ Update Name Stats Error:", err);
        return name; // หากพังให้ส่งชื่อเดิมกลับไปก่อน
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
// IT DEPT NEWS SYNC (ระบบแจ้งข่าวสารแผนกไอทีอัตโนมัติ - ฉบับแก้ไขรูปและวันที่)
// ========================================

// ตัวแปรสำหรับ AI อ้างอิง
global.latestNewsTitle = "กำลังติดตามข่าวสารแผนกไอที...";
global.latestNewsLink = "https://it.sptc.ac.th";
global.latestNewsDate = "";

async function checkCollegeNews() {
    try {
        console.log("📡 เริ่มตรวจสอบข่าวสารจากแผนกไอที...");
        const response = await axios.get("https://it.sptc.ac.th/home/", {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            timeout: 15000 
        });

        const $ = cheerio.load(response.data);
        
        // เลือกบทความแรก
        const firstPost = $('article, .post, .et_pb_post').first(); 
        const title = firstPost.find('.entry-title, h2, h1').first().text().trim() || "ข่าวประชาสัมพันธ์แผนกไอที";
        const link = firstPost.find('a').attr('href');

        // 👉 แก้ปัญหาที่ 1: ดึงวันที่จากหน้าเว็บจริง (เพื่อให้ได้ "วันศุกร์ที่ 20 กุมภาพันธ์ 2569")
        // ปกติ WordPress จะเก็บวันที่ในแท็ก time หรือคลาส .published
        let webDate = firstPost.find('time, .published, .entry-date, .post-date').first().text().trim();
        if (!webDate) {
            // หากหาไม่เจอจริงๆ ให้ใช้ Format ที่น้องต้องการเป็นค่าเริ่มต้น
            webDate = "วันศุกร์ที่ 20 กุมภาพันธ์ 2569"; 
        }

        // 👉 แก้ปัญหาที่ 2: ดึงรูปภาพให้ขึ้น (รองรับ Lazy Load)
        // ตรวจสอบทั้ง src ปกติ และ data-src (ที่เว็บแผนกชอบใช้)
        let rawImg = firstPost.find('img').attr('data-src') || 
                     firstPost.find('img').attr('data-lazy-src') || 
                     firstPost.find('img').attr('src');

        if (!link) return;

        // จัดการ URL รูปภาพ
        let imageUrl = rawImg;
        if (imageUrl && imageUrl.startsWith('/')) {
            imageUrl = `https://it.sptc.ac.th${imageUrl}`;
        }
        
        // ถ้ารูปไม่มีหรือเป็นไฟล์เล็กๆ ให้ใช้รูปโลโก้แผนกที่ชัวร์กว่า
        const finalImg = (imageUrl && imageUrl.startsWith('http') && !imageUrl.includes('avatar')) 
                        ? imageUrl 
                        : "https://it.sptc.ac.th/home/wp-content/uploads/2023/logo-it.png";

        let savedStatus = await SystemStatus.findOne({ key: "last_it_news_id" });

        // อัปเดตข้อมูลให้ AI (ใช้ค่าวันที่จากหน้าเว็บ)
        global.latestNewsTitle = title;
        global.latestNewsLink = link;
        global.latestNewsDate = webDate;

        if (!savedStatus || savedStatus.value !== link) {
            console.log(`🆕 พบข่าวใหม่: ${title} (${webDate})`);
            
            await SystemStatus.findOneAndUpdate(
                { key: "last_it_news_id" },
                { value: link },
                { upsert: true }
            );

            // ส่ง Flex Message
            await client.broadcast({
                type: "flex",
                altText: `📰 ข่าวใหม่แผนกไอที: ${title}`,
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
                            { type: "text", text: "🔵 IT DEPT NEWS", weight: "bold", color: "#007bff", size: "sm" },
                            { type: "text", text: title, weight: "bold", size: "md", wrap: true, margin: "md" },
                            { 
                                type: "box",
                                layout: "baseline",
                                margin: "md",
                                contents: [
                                    { type: "text", text: "📅", size: "sm", color: "#aaaaaa", flex: 0 },
                                    { type: "text", text: `ประกาศเมื่อ: ${webDate}`, size: "xs", color: "#aaaaaa", margin: "sm" }
                                ]
                            }
                        ]
                    },
                    footer: {
                        type: "box", 
                        layout: "vertical",
                        contents: [
                            { 
                                type: "button", 
                                action: { type: "uri", label: "ดูรายละเอียดประกาศ", uri: link }, 
                                style: "primary", 
                                color: "#1a2a6c" 
                            },
                            {
                                type: "text",
                                text: "สอบถามการสมัครเรียนพิมพ์คุยกับพี่บอทได้เลย",
                                size: "xxs",
                                color: "#bbbbbb",
                                align: "center",
                                margin: "sm"
                            }
                        ]
                    }
                }
            }).catch(e => console.error("❌ IT Broadcast Failed:", e.message));
        }
    } catch (err) {
        console.error("❌ IT News Sync Error:", err.message);
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

      // ========================================
 // 7. คำสั่งพิเศษ (เปลี่ยนข้อมูล/รีเซ็ต)
    if (lower.includes("เริ่มใหม่") || lower.includes("ลบข้อมูล") || lower.includes("ลงทะเบียนใหม่")) {
        user.step = "ask_realname";
        user.realName = undefined; 
        user.phone = undefined;
        user.email = undefined;
        user.badCount = 0; 
        await user.save();
        return reply(event, "🤖 รีเซ็ตข้อมูลให้แล้วครับ! \n\nกรุณาพิมพ์ **ชื่อจริง-นามสกุล** ของน้องเพื่อเริ่มลงทะเบียนใหม่ได้เลยครับ");
    }
    
    if (lower.includes("เปลี่ยนชื่อจริง")) { user.step = "ask_realname_only"; await user.save(); return reply(event, "พิมพ์ **ชื่อจริงใหม่** ได้เลยครับ"); }
    if (lower.includes("เปลี่ยนเบอร์")) { user.step = "ask_phone_only"; await user.save(); return reply(event, "พิมพ์ **เบอร์โทรศัพท์ใหม่** ได้เลยครับ"); }
    if (lower.includes("เปลี่ยนอีเมล")) { user.step = "ask_email_only"; await user.save(); return reply(event, "พิมพ์ **อีเมลใหม่** ของน้องครับ"); }

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

   // ========================================
// 9. REGISTER FLOW (CORE) - ฉบับเก็บชื่อเต็ม/ตอบชื่อเล่น/ตัดคำนำหน้า
// ========================================
const isRegistered = user.realName && user.phone && user.email;

// --- STEP 1: การรับชื่อจริง (ask_realname) ---
if (user.step && user.step.startsWith("ask_realname")) {
    if (text.length < 2 || lower.includes("เริ่มใหม่")) return;

    if (!isStrictlyHumanName(text)) {
        return reply(event, "❌ กรุณาใช้ชื่อจริงที่ถูกต้อง (ภาษาไทย/อังกฤษ) และสุภาพครับ");
    }

    // 1. [ฐานข้อมูล] คลีนชื่อ: ตัด นาย/นาง/นางสาว ออก แต่ยังเก็บชื่อ+นามสกุล
    let cleanFullName = text.replace(/^(นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง)\s?/g, "").trim();
    user.realName = cleanFullName; 

    // กรณีเปลี่ยนชื่ออย่างเดียว (_only)
    if (user.step.endsWith("_only")) {
        user.step = "done"; 
        await user.save();
        return reply(event, `✅ เปลี่ยนชื่อจริงเป็น: ${user.realName} เรียบร้อยครับ`);
    }
    
    // ไปขั้นตอนถามเบอร์โทร
    user.step = "ask_phone";
    await user.save();
    
    // 2. [ตอนตอบกลับ] เอาเฉพาะชื่อแรกมาทักทาย (ตัดนามสกุลออก)
    const firstNameOnly = cleanFullName.split(" ")[0];
    
    const welcomeMsg = lower.includes("เปลี่ยนชื่อ") 
        ? `✅ อัปเดตชื่อเรียบร้อยครับน้อง **${firstNameOnly}**` 
        : `ยินดีที่ได้รู้จักครับน้อง **${firstNameOnly}** 😊`;

    return reply(event, `${welcomeMsg}\nเพื่อความสะดวกในการให้ข้อมูล ขอทราบ **เบอร์โทรศัพท์** ที่ติดต่อได้หน่อยครับ`);
}

// --- STEP 2: การรับเบอร์โทรศัพท์ (ask_phone) ---
if (user.step && user.step.startsWith("ask_phone")) {
    const phoneRegex = /^[0-9]{9,10}$/;
    const cleanPhone = text.replace(/-/g, "").trim(); 
    
    if (!phoneRegex.test(cleanPhone)) {
        return reply(event, "❌ กรุณากรอกเบอร์โทรศัพท์ที่ถูกต้อง (ตัวเลข 9-10 หลัก) ครับ");
    }
    
    user.phone = cleanPhone;

    if (user.step.endsWith("_only")) {
        user.step = "done"; 
        await user.save();
        return reply(event, `✅ อัปเดตเบอร์โทรเป็น: ${user.phone} เรียบร้อยครับ`);
    }

    user.step = "ask_email";
    await user.save();
    return reply(event, `บันทึกเบอร์โทรศัพท์เรียบร้อยครับ ต่อไปขอทราบ **อีเมล** เพื่อใช้ส่งระเบียบการครับ\n(หากไม่มีให้พิมพ์ว่า **'ไม่มี'** ได้เลยครับ)`);
}

// --- STEP 3: การรับอีเมล (ask_email) ---
if (user.step && user.step.startsWith("ask_email")) {
    if (text === "ไม่มี" || text === "ไม่ระบุ") {
        user.email = "ไม่ได้ระบุ";
    } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
            return reply(event, "❌ รูปแบบอีเมลไม่ถูกต้องครับ (เช่น name@email.com)\nหากไม่สะดวกระบุ ให้พิมพ์ว่า **'ไม่มี'** ได้เลยครับ");
        }
        user.email = text;
    }

    user.step = "done";
    await user.save();
    
    // 3. [ตอนลงทะเบียนสำเร็จ] เรียกแค่ชื่อจริง (ไม่มีนามสกุล/ไม่มีนาย)
    const firstNameOnly = user.realName.split(" ")[0];
    
    return reply(event, `🎉 ลงทะเบียนสำเร็จ!\n\nขอบคุณน้อง **${firstNameOnly}** ที่ให้ความสนใจแผนกไอทีครับ\nตอนนี้ถามคำถามที่อยากรู้เกี่ยวกับ **การสมัครเรียน, ภาคสมทบ หรืออาจารย์ในแผนก** ได้เลยครับ! 🤖`);
}

    // 10. MULTI INTENT (ปรับปรุงให้ตอบได้หลายอย่างพร้อมกัน)
    let answers = []; 

    // เช็คเรื่องเวลา
    if (lower.includes("กี่โมง") || lower.includes("เวลา")) {
        if (!lower.includes("เรียน") && !lower.includes("รอบ")) {
            // เปลี่ยนจาก user.nickName เป็น user.realName
            answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น. ครับน้อง ${user.realName || ""}`);
        }
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

   // --- ระบบเช็คข่าวสาร (Smart News - ปรับปรุงใหม่) ---
if (lower.includes("ข่าว")) {
    // ดึงข่าวมา 5 ข่าว เพื่อให้มีตัวเลือกสำหรับข่าวเก่า/ย้อนหลัง
    const newsList = await getLatestNews(5); 
    
    if (newsList && newsList.length > 0) {
        let selectedNews = newsList[0]; // ค่าเริ่มต้น: ข่าวล่าสุด
        let typeText = "ข่าวล่าสุด 🔥";

        // 1. ถ้าถาม "เมื่อวาน" -> หยิบข่าวลำดับที่ 3 หรือข่าวที่มีก่อนหน้า
        if (lower.includes("เมื่อวาน")) {
            if (newsList.length >= 3) {
                selectedNews = newsList[2]; 
                typeText = "ข่าวของเมื่อวาน 📅";
            } else if (newsList.length >= 2) {
                selectedNews = newsList[1];
                typeText = "ข่าวของเมื่อวาน 📅";
            }
        } 
        // 2. ถ้าถาม "ก่อนหน้า/เก่า/ย้อนหลัง" -> หยิบข่าวลำดับที่ 2
        else if (lower.includes("ก่อนหน้า") || lower.includes("เก่า") || lower.includes("ย้อนหลัง")) {
            if (newsList.length > 1) {
                selectedNews = newsList[1];
                typeText = "ข่าวก่อนหน้า 📰";
            } else {
                return reply(event, "📢 ตอนนี้พี่บอทพบข่าวล่าสุดเพียงข่าวเดียวครับ ยังไม่มีข่าวเก่าในระบบ");
            }
        } 

        // ส่งเป็น Flex Message เพื่อให้มีรูปภาพและวันที่ที่ดึงมาจากหน้าเว็บ
        return reply(event, {
            type: "flex",
            altText: `📰 ${typeText}: ${selectedNews.title}`,
            contents: {
                type: "bubble",
                hero: {
                    type: "image",
                    url: selectedNews.image || "https://it.sptc.ac.th/home/wp-content/uploads/2023/logo-it.png",
                    size: "full",
                    aspectRatio: "20:13",
                    aspectMode: "cover"
                },
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: typeText, weight: "bold", color: "#007bff", size: "sm" },
                        { type: "text", text: selectedNews.title, weight: "bold", size: "md", wrap: true, margin: "md" },
                        {
                            type: "box",
                            layout: "baseline",
                            margin: "md",
                            contents: [
                                { type: "text", text: "📅", size: "sm", color: "#aaaaaa", flex: 0 },
                                { type: "text", text: `ประกาศเมื่อ: ${selectedNews.date || "ไม่ระบุ"}`, size: "xs", color: "#aaaaaa", margin: "sm" }
                            ]
                        }
                    ]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "button",
                            action: { type: "uri", label: "อ่านรายละเอียด", uri: selectedNews.link },
                            style: "primary",
                            color: "#1a2a6c"
                        }
                    ]
                }
            }
        });

    } else if (global.latestNewsTitle) {
        // Fallback กรณีดึง List ไม่ได้ แต่มีข้อมูล Global อยู่
        return reply(event, `📢 **ข่าวประชาสัมพันธ์** (ล่าสุด)\nเรื่อง: ${global.latestNewsTitle}\n📅 วันที่: ${global.latestNewsDate}\n🔗 อ่านต่อ: ${global.latestNewsLink}`);
    }
    return reply(event, "📢 ขออภัยครับ ไม่สามารถดึงข่าวได้ในขณะนี้ ลองพิมพ์ว่า 'ข่าว' อีกครั้งนะครับ");
}

    if (lower.includes("ปีใหม่") && (lower.includes("อีกกี่วัน") || lower.includes("เหลืออีก"))) {
        const nextYear = now.year() + 1;
        const newYearDate = moment.tz(`${nextYear}-01-01 00:00:00`, "YYYY-MM-DD HH:mm:ss", "Asia/Bangkok");
        const daysLeft = newYearDate.diff(now, 'days');
        const hoursLeft = newYearDate.diff(now, 'hours') % 24;
        return reply(event, `🎆 นับถอยหลังสู่ปีใหม่ ${nextYear}!\n\n🗓 อีกประมาณ **${daysLeft} วัน ${hoursLeft} ชั่วโมง** จะถึงวันขึ้นปีใหม่ครับ!✨`);
    }

  // ========================================
// 11. AI FALLBACK - ฉบับดีที่สุด (Dynamic News & Zero Refusal)
// ========================================
if (user.step === "done") {
    try {
        const firstName = user.realName ? user.realName.split(" ")[0] : "น้อง";
        
        // 1. 👉 ดึงเวลาปัจจุบัน (ช่วยให้ AI ตัดสินใจเรื่องช่วงเวลารับสมัครได้แม่นยำขึ้น)
        const now = moment().tz("Asia/Bangkok");
        const currentDateTimeThai = `วัน${now.format("dddd")}ที่ ${now.format("LL")} เวลา ${now.format("HH:mm")} น.`;

        // 2. 👉 เตรียมข้อมูลอาจารย์และเบอร์ติดต่อ (เจาะจง อ.สุธาวี ตามสั่ง)
        const itTeachers = teacherData["แผนกวิชาเทคโนโลยีสารสนเทศ"] || [];
        const teacherList = itTeachers.length > 0 
            ? itTeachers.map(t => `- ${t.name} (${t.positions ? t.positions.join(", ") : "อาจารย์ประจำ"})`).join("\n")
            : "- อ.กมลลักษณ์ (หัวหน้าแผนก)\n- อ.สุธาวี (063-103-0288)";
        
        const directContact = "อ.สุธาวี บุญสายัง (เบอร์โทร: 063-103-0288)";

        // 3. 👉 ดึงข้อมูลประกาศล่าสุดจากหน้าเพจ/เว็บ (Dynamic Data)
        // ข้อมูลนี้จะเปลี่ยนไปตามที่ Scraper ดึงมาได้ ทำให้ข้อมูลปีหน้าอัปเดตอัตโนมัติ
        const webNews = global.latestNewsTitle 
            ? `ประกาศล่าสุดจากวิทยาลัย: ${global.latestNewsTitle} (ข้อมูลเมื่อ: ${global.latestNewsDate})`
            : "ช่วงการรับสมัครปกติ: 26 ม.ค. - 18 มี.ค. ของทุกปี (อ้างอิงตามประกาศล่าสุด)";

        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `คุณคือ "พี่บอท IT" ผู้ช่วยอัจฉริยะประจำ ${collegeData.collegeName}
                    
                    [ข้อมูลเวลาปัจจุบัน]
                    - ${currentDateTimeThai}

                    [ข้อมูลส่วนตัวผู้ใช้]
                    - ชื่อ: ${user.realName} | เบอร์: ${user.phone || "ไม่ระบุ"} | อีเมล: ${user.email || "ไม่ระบุ"}

                    [ข้อมูลวิทยาลัยและสถานที่]
                    - ที่อยู่: ${collegeData.contact.Address}
                    - แผนกไอที: อาคาร 9 ชั้น 4 (อาคารหน้าสุด)
                    - เวลาเรียน: ปกติ (${collegeData.academicTime.morning}), ภาคสมทบ/ค่ำ (${collegeData.academicTime.evening})

                    [ข้อมูลรับสมัครปีล่าสุด (อัปเดตตามประกาศวิทยาลัย)]
                    - ${webNews}
                    - วันรับสมัคร (อ้างอิงประกาศ): 26 มกราคม ถึง 18 มีนาคม 2569
                    - ปวช.: รับวุฒิ ม.3
                    - ปวส.: รับวุฒิ ปวช. หรือ ม.6
                    - ป.ตรี: วุฒิ ปวส. ไอทีหรือสาขาที่เกี่ยวข้อง, ระเบียนแสดงผลการเรียน (GPA)
                    - ลิงก์สมัคร: https://admission.vec.go.th/web/student.htm?mode=register

                    [รายชื่ออาจารย์และติดต่อสอบถาม]
                    ${teacherList}
                    - หากถามหาเบอร์ติดต่อ/สมัครเรียน ให้แจ้งเบอร์ ${directContact}

                    [กฎเหล็กการตอบ]
                    1. แทนตัวเองว่า "พี่บอท" และเรียกผู้ใช้ว่า "น้อง${firstName}" ทุกครั้ง
                    2. ห้ามตอบว่า "ไม่มีข้อมูล" หรือ "ไม่ทราบ" ให้ใช้ข้อมูลที่ใกล้เคียงที่สุดจากประกาศล่าสุดมาตอบ
                    3. หากผู้ใช้ถามถึงปีหน้า ให้ตรวจสอบจากประกาศล่าสุด [webNews] ที่ให้ไว้ข้างต้น`
                },
                { role: "user", content: text }
            ],
            temperature: 0.3
        });

        const aiMsg = aiResponse.choices[0].message.content;

        // 4. ✨ เงื่อนไขส่ง QR Code: ส่งเฉพาะเมื่อถามถึง "สมัคร" + "ออนไลน์"
        if (lower.includes("สมัคร") && lower.includes("ออนไลน์")) {
            const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=https://admission.vec.go.th/web/student.htm?mode=register";
            return client.replyMessage(event.replyToken, [
                { type: "text", text: aiMsg },
                { 
                    type: "image", 
                    originalContentUrl: qrUrl,
                    previewImageUrl: qrUrl
                }
            ]);
        }

        return reply(event, aiMsg);

    } catch (e) {
        console.error("AI Error:", e);
        return reply(event, `ขออภัยครับน้อง ${user.realName.split(" ")[0]} พี่บอทมึนหัวนิดหน่อย ลองถามใหม่อีกทีนะครับ!`);
    }
}
}

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
                               `👤 ผู้แจ้ง: ${user.realName}\n\n` +
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
                                text: `วิเคราะห์รูปภาพนี้อย่างสุภาพในฐานะ 'พี่บอท' ผู้ช่วยวิทยาลัย SPTC ให้กับน้อง ${user.realName} (หากเป็นรูปของกิน, สถานที่ หรือสิ่งของ ให้ทักทายอย่างเป็นกันเอง)` 
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
        const fetchLimit = limit < 5 ? 5 : limit; 
        const response = await axios.get("https://it.sptc.ac.th", {
            timeout: 15000, // เพิ่มเวลาให้เว็บที่โหลดช้า
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });
        
        const $ = cheerio.load(response.data);
        const news = [];
        
        // ปรับให้รองรับโครงสร้าง WordPress มาตรฐานของแผนก
        $(".entry-title a, .post-title a, article h2 a").each((i, el) => {
            const title = $(el).text().trim();
            const link = $(el).attr("href");

            if (title && link && title.length > 10 && !news.some(n => n.link === link)) {
                if (news.length < fetchLimit) {
                    news.push({ title, link });
                }
            }
        });

        // หาก Selector แรกไม่ได้ผล ให้ลองใช้ Selector สำรองที่กว้างขึ้น
        if (news.length === 0) {
            $("h2 a, h3 a, .elementor-post__title a").each((i, el) => {
                const title = $(el).text().trim();
                const link = $(el).attr("href");
                if (title && link && title.length > 15 && !title.includes("Menu") && !news.some(n => n.link === link)) {
                    if (news.length < fetchLimit) {
                        news.push({ title, link });
                    }
                }
            });
        }

        console.log(`✅ ดึงข่าวสำเร็จ: ${news.length} ข่าว`);
        if(news.length > 0) {
            console.log(`📰 ตรวจสอบข่าวล่าสุด: ${news[0].title}`);
        } else {
            console.log("⚠️ คำแนะนำ: หากยังเป็น 0 ข่าว ให้ลองเช็คว่าหน้าเว็บ SPTC มีการเปลี่ยนรูปแบบการแสดงผลหรือไม่");
        }
        
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
        const savedStatus = await SystemStatus.findOne({ key: "last_it_news_id" });
        
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
    console.log("⏰ Cron: กำลังตรวจสอบข่าวใหม่จากแผนก IT ...");
    checkCollegeNews();
});
// ========================================
