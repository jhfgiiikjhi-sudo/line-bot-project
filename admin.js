'use strict';

const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');

/* ===============================
   CONFIG
================================ */
const USERS_FILE = path.join(__dirname, 'users.json');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

/* ===============================
   ADMIN SETUP
================================ */
const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

/* ===============================
   LOAD USERS
================================ */
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/* ===============================
   HELPER
================================ */
async function reply(event, text) {
  if (!event.replyToken) return;
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text
  });
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

/* ===============================
   ADMIN HANDLER
================================ */
module.exports = async function adminHandler(event) {
  const userId = event.source?.userId;
  const text = event.message?.text?.trim();

  if (!userId || !text) return;

  // 🔐 ตรวจสิทธิ์
  if (!isAdmin(userId)) {
    return reply(event, '⛔ คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้น');
  }

  const args = text.split(' ');
  const command = args[1]; // /admin <command>

  const users = loadUsers();
  const userIds = Object.keys(users);

  /* ===============================
     HELP
  ================================ */
  if (!command || command === 'help') {
    return reply(
      event,
      `🛠️ คำสั่งผู้ดูแลระบบ

/admin help
/admin stats
/admin users
/admin view <userId>
/admin reset <userId>
/admin broadcast <ข้อความ>`
    );
  }

  /* ===============================
     STATS
  ================================ */
  if (command === 'stats') {
    return reply(
      event,
      `📊 สถิติระบบ
👥 จำนวนผู้ใช้ทั้งหมด: ${userIds.length}`
    );
  }

  /* ===============================
     USERS
  ================================ */
  if (command === 'users') {
    if (userIds.length === 0) {
      return reply(event, 'ยังไม่มีผู้ใช้ในระบบ');
    }

    return reply(
      event,
      `👥 รายชื่อผู้ใช้ทั้งหมด:\n\n${userIds.join('\n')}`
    );
  }

  /* ===============================
     VIEW USER
  ================================ */
  if (command === 'view') {
    const targetId = args[2];
    if (!targetId || !users[targetId]) {
      return reply(event, '❌ ไม่พบ userId นี้');
    }

    return reply(
      event,
      `👤 ข้อมูลผู้ใช้
ID: ${targetId}
ชื่อ: ${users[targetId].name || '-'}
อายุ: ${users[targetId].age || '-'}
วันเกิด: ${users[targetId].birthday || '-'}
ขั้นตอน: ${users[targetId].step || '-'}`
    );
  }

  /* ===============================
     RESET USER
  ================================ */
  if (command === 'reset') {
    const targetId = args[2];
    if (!targetId || !users[targetId]) {
      return reply(event, '❌ ไม่พบ userId นี้');
    }

    delete users[targetId];
    saveUsers(users);

    return reply(event, `✅ รีเซ็ตข้อมูลของ ${targetId} เรียบร้อย`);
  }

  /* ===============================
     BROADCAST
  ================================ */
  if (command === 'broadcast') {
    const message = args.slice(2).join(' ');
    if (!message) {
      return reply(event, '❌ กรุณาใส่ข้อความที่จะส่ง');
    }

    let success = 0;

    for (const uid of userIds) {
      try {
        await client.pushMessage(uid, {
          type: 'text',
          text: `📢 ข้อความจากผู้ดูแลระบบ\n\n${message}`
        });
        success++;
      } catch {
        // ignore user ที่ block
      }
    }

    return reply(
      event,
      `📣 ส่งข้อความเรียบร้อย
สำเร็จ: ${success}/${userIds.length} คน`
    );
  }

  /* ===============================
     UNKNOWN COMMAND
  ================================ */
  return reply(event, '❓ ไม่รู้จักคำสั่งนี้ พิมพ์ /admin help');
};
