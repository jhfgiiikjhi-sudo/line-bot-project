'use strict';

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
require('moment/locale/th');
const line = require('@line/bot-sdk');

/* ===============================
   CONFIG
================================ */
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 นาที

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

/* ===============================
   USER STORAGE
================================ */
let users = {};

if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/* ===============================
   HELPER
================================ */
function reply(event, text) {
  if (!event.replyToken) return;
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text
  });
}

function resetUser(userId) {
  users[userId] = {
    step: 'ask_name',
    lastActive: Date.now()
  };
  saveUsers();
}

/* ===============================
   MAIN REPLY FUNCTION
================================ */
module.exports = async function replyHandler(event) {
  const userId = event.source?.userId;
  const text = event.message?.text?.trim();

  if (!userId || !text) {
    return reply(event, 'ขออภัยครับ ผมไม่เข้าใจข้อความนี้ 😊');
  }

  const lowerText = text.toLowerCase();
  const now = Date.now();

  /* ===== CREATE USER ===== */
  if (!users[userId]) {
    resetUser(userId);
    return reply(event, 'สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ');
  }

  const user = users[userId];

  /* ===== SESSION TIMEOUT ===== */
  if (user.lastActive && now - user.lastActive > SESSION_TIMEOUT) {
    resetUser(userId);
    return reply(
      event,
      'คุณหายไปสักพักนะครับ 😊\nขอเริ่มต้นใหม่อีกครั้ง\nกรุณาพิมพ์ชื่อของคุณครับ'
    );
  }

  user.lastActive = now;
  saveUsers();

  /* ===== GLOBAL COMMAND ===== */
  if (['เริ่มใหม่', 'reset', 'ล้างข้อมูล'].includes(lowerText)) {
    resetUser(userId);
    return reply(event, 'รีเซ็ตข้อมูลเรียบร้อยครับ 😊\nกรุณาพิมพ์ชื่อของคุณ');
  }

  if (
    lowerText.includes('เปลี่ยนชื่อ') ||
    lowerText.includes('ขอพิมพ์ชื่อใหม่')
  ) {
    user.step = 'ask_name';
    delete user.name;
    saveUsers();
    return reply(event, 'ได้เลยครับ 😊 กรุณาพิมพ์ชื่อใหม่ของคุณ');
  }

  /* ===============================
     STEP : ASK NAME
  ================================ */
  if (user.step === 'ask_name') {
    const banned = [
      'ข้าม',
      'skip',
      'ไม่บอก',
      'ไม่บอกชื่อ',
      'test',
      '123',
      'abc',
      'xxx',
      'zzz'
    ];

    if (
      banned.includes(lowerText) ||
      text.length < 2 ||
      text.length > 20 ||
      !/^[ก-๙a-zA-Z\s]+$/.test(text)
    ) {
      return reply(
        event,
        '❌ กรุณาพิมพ์ชื่อจริงที่ใช้เรียก (ภาษาไทยหรืออังกฤษ 2–20 ตัวอักษร)\n*ขั้นตอนนี้ไม่สามารถข้ามได้ครับ*'
      );
    }

    user.name = text;
    user.step = 'ask_age';
    saveUsers();

    return reply(
      event,
      `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`
    );
  }

  /* ===============================
     STEP : ASK AGE
  ================================ */
  if (user.step === 'ask_age') {
    if (['ข้าม', 'skip', 'ไม่บอก'].includes(lowerText)) {
      return reply(event, '❌ ขั้นตอนอายุไม่สามารถข้ามได้ครับ');
    }

    const age = Number(text);
    if (!Number.isInteger(age) || age < 1 || age > 60) {
      return reply(event, '❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60 เท่านั้น');
    }

    user.age = age;
    user.step = 'ask_birthday';
    saveUsers();

    return reply(
      event,
      'วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ "ข้าม"'
    );
  }

  /* ===============================
     STEP : ASK BIRTHDAY (OPTIONAL)
  ================================ */
  if (user.step === 'ask_birthday') {
    if (['ข้าม', 'skip', 'ไม่บอก'].includes(lowerText)) {
      user.birthday = null;
      user.step = 'done';
      saveUsers();

      return reply(
        event,
        `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด: ไม่ได้ระบุ`
      );
    }

    if (!moment(text, 'DD/MM/YYYY', true).isValid()) {
      return reply(
        event,
        '❌ รูปแบบวันเกิดไม่ถูกต้อง\nกรุณาพิมพ์ DD/MM/YYYY หรือพิมพ์ "ข้าม"'
      );
    }

    user.birthday = text;
    user.step = 'done';
    saveUsers();

    return reply(
      event,
      `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด ${user.birthday}`
    );
  }

  /* ===============================
     NORMAL MODE
  ================================ */

  if (lowerText.includes('วันเกิด')) {
    if (!user.birthday) {
      return reply(event, 'คุณยังไม่ได้บอกวันเกิดไว้ครับ');
    }

    const nowMoment = moment().tz('Asia/Bangkok');
    const [d, m] = user.birthday.split('/');
    let next = moment.tz(
      `${nowMoment.year()}-${m}-${d}`,
      'Asia/Bangkok'
    );

    if (next.isBefore(nowMoment, 'day')) {
      next.add(1, 'year');
    }

    const diff = next.startOf('day').diff(nowMoment.startOf('day'), 'days');
    return reply(event, `🎂 เหลืออีก ${diff} วัน จะถึงวันเกิดของคุณครับ`);
  }

  /* ===== FINAL FALLBACK (NO SILENT) ===== */
  return reply(
    event,
    'ขออภัยครับ ผมยังไม่เข้าใจคำถามนี้ 😊\nคุณสามารถพิมพ์ "เริ่มใหม่" ได้ครับ'
  );
};
