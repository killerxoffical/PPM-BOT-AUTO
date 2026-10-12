require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// ---------------- 1. EXPRESS HTTP SERVER ----------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

app.listen(PORT, "0.0.0.0", () => console.log(`[HTTP] Server active on port ${PORT}`));

// ---------------- 2. FIREBASE ADMIN ----------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    serviceAccount = require("./serviceAccountKey.json");
}
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- 3. CONFIGURATIONS ----------------
// ✅ আপনার দেওয়া নতুন ID ও Hash কোডের ভেতর স্থায়ীভাবে যুক্ত করা হলো
const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID || 39447470);
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAEu4CX0T9Dz6YMLxeCNz6U-nbiQmiBiJ_s";
const ORDER_LOG_CHANNEL = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

const userNotifyBot = new TelegramBot(USER_NOTIFY_BOT_TOKEN, { polling: true });
userNotifyBot.on("polling_error", () => {}); // 409 error silence

let currentClient = null;
let currentPhone = null;
let primeClient = null;
let primePhone = null;

const activeOrders = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map();

// সঠিক BD Phone Formatter
function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+880" + num.substring(1);
    if (num.startsWith("1") && num.length === 10) return "+880" + num;
    return "+" + num;
}

// ---------------- 7. DIRECT SESSION & OTP GENERATOR ----------------
// ১. নম্বর দিলে OTP পাঠাবে
app.post("/api/tg/send-otp", async (req, res) => {
    const rawInput = req.body.phone || "";
    const phone = formatBdPhone(rawInput);

    console.log(`[TG LOGIN] Requesting OTP for phone: ${phone} (Using API_ID: ${DEFAULT_API_ID})`);

    if (!phone || phone.length < 13) {
        return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    try {
        const stringSession = new StringSession("");
        const tempClient = new TelegramClient(stringSession, DEFAULT_API_ID, DEFAULT_API_HASH, { 
            connectionRetries: 5,
            useWSS: false
        });

        await tempClient.connect();
        const result = await tempClient.sendCode({ 
            apiId: DEFAULT_API_ID, 
            apiHash: DEFAULT_API_HASH 
        }, phone);

        // মেমোরিতে ক্লায়েন্ট ও ফোন কোড হ্যাশ ধরে রাখা হলো
        pendingAuthClients.set(phone, { 
            client: tempClient, 
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        console.log(`[TG LOGIN] OTP Sent Successfully to: ${phone}`);
        return res.json({ ok: true, message: "OTP পাঠানো হয়েছে!", phone });
    } catch (err) {
        console.error(`[TG LOGIN ERR] Error:`, err);
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "Failed to send OTP" });
    }
});

// Universal 2FA SRP Calculator Helper
async function computeSrpHash(client, password) {
    if (typeof client.checkPassword === "function") {
        return await client.checkPassword(password);
    }
    let computeFn = null;
    const candidates = [
        () => require("telegram/Password").computeCheckPassword,
        () => require("telegram/Password"),
        () => require("telegram/Password.js").computeCheckPassword,
        () => require("telegram/Password.js"),
        () => require("telegram").computeCheckPassword,
        () => require("telegram").Password?.computeCheckPassword,
        () => require("telegram/Utils")?.computeCheckPassword
    ];
    for (const cand of candidates) {
        try {
            const fn = cand();
            if (typeof fn === "function") { computeFn = fn; break; }
            if (fn && typeof fn.default === "function") { computeFn = fn.default; break; }
            if (fn && typeof fn.computeCheckPassword === "function") { computeFn = fn.computeCheckPassword; break; }
        } catch (e) {}
    }
    const srpResult = await client.invoke(new Api.account.GetPassword());
    if (computeFn) return await computeFn(srpResult, password);
    throw new Error("2FA Password module resolution failed");
}

// ২. OTP দিলে সেশন বানিয়ে স্বয়ংক্রিয়ভাবে ডাটাবেসে লগইন করিয়ে দেবে
app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ! আবার Send OTP চাপুন।" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            // যদি অ্যাকাউন্টে 2FA পাসওয়ার্ড চালু থাকে
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && (signInErr.message.includes("2FA") || signInErr.message.includes("PASSWORD")))) {
                if (!password) return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড দিন" });

                if (typeof item.client.checkPassword === "function") {
                    await item.client.checkPassword(password);
                } else {
                    const passwordSrpHash = await computeSrpHash(item.client, password);
                    await item.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpHash }));
                }
            } else {
                throw signInErr;
            }
        }

        // ✅ স্বয়ংক্রিয়ভাবে সেশন স্ট্রিং তৈরি হলো
        const sessionString = item.client.session.save();
        console.log(`[SESSION GENERATED] Session created successfully for: ${phone}`);

        const docId = phone.replace('+', '');
        // ফায়ারবেসে সেশন ও অ্যাকাউন্ট সেভ
        await db.collection("tg_accounts").doc(docId).set({
            phone,
            session: sessionString,
            balance: 0,
            active: true,
            isPrime: false,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        return res.json({ ok: true, message: "অ্যাকাউন্ট সফলভাবে কানেক্ট হয়েছে!", phone, session: sessionString });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "ভেরিফিকেশন ব্যর্থ" });
    }
});

// ---------------- 8. REAL BALANCE AUDIT API ----------------
function parseBotBalance(text) {
    if (!text) return null;
    const match = text.match(/(?:balance|new balance|current balance)\s*[:\-]?\s*(\d+)/i) 
               || text.match(/(\d+)\s*(?:tokens|token|🪙)/i);
    return match ? Number(match[1]) : null;
}

app.post("/api/tg/check-balance", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট পুলে নেই" });

        let totalBalance = 0;
        const results = [];

        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const tempClient = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await tempClient.connect();
                await tempClient.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
                await new Promise((r) => setTimeout(r, 2500));

                const msgs = await tempClient.getMessages(TARGET_BOT, { limit: 1 });
                let b = null;
                if (msgs && msgs.length > 0) b = parseBotBalance(msgs[0].message);

                if (b !== null) {
                    await db.collection("tg_accounts").doc(docSnap.id).update({
                        balance: b, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    totalBalance += b;
                    results.push({ phone, balance: b });
                } else {
                    results.push({ phone, balance: acc.balance || 0 });
                }
                await tempClient.disconnect();
            } catch (err) {
                results.push({ phone, balance: acc.balance || 0 });
            }
        }

        await db.collection("config").doc("app").set({
            botTokensTotal: totalBalance, botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 13. MASTER WORKER START ----------------
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Master Guardian...");
    console.log(`[CONFIG] Using API_ID: ${DEFAULT_API_ID}`);
    console.log("[MASTER INIT] Active!");
}

startMasterWorker().catch(console.error);