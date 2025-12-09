const express = require('express');
const app = express();
require('dotenv').config();

const line = require('@line/bot-sdk');


const config = {
    channelAccessToken: process.env.token,
    channelSecret: process.env.secretcode
};

app.post('/webhook', line.middleware(config), (req, res) => {
    Promise
        .all(
            req.body.events.map(handleEvent)
        )
        .then((result) => res.json(result)) 
        .catch(err => {
            console.error('error handling events', err);
            res.status(500).send('error');
        });
});

const client = new line.Client(config);

function handleEvent(event) {

    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }


    return client.replyMessage(event.replyToken, [
        {
        "type": "text",
        "text": "ยินดีที่ได้รู้จักครับ ผมชื่อ บอทไลน์",
        "quoteToken": event.message.quoteToken
        },
        {
        "type": "text", 
        "text": "เป็นที่ปรึกษา และเพื่อนคุยของคุณครับ"
        },
        {
        "type": "text", 
        "text": "คุณมีคำถาม หรือให้ผมช่วยอะไรไหมครับ?"
        }
    ]);     


    console.log(event);


}   

app.get('/', (req, res) => {
    res.send('ok');
});
app.listen(8080, () => console.log('Server running on port 8080'));