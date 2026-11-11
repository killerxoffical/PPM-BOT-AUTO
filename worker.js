
// Global Process Guards against fatal unhandled promise crashes on Render
process.on("unhandledRejection", (err) => console.warn("[Worker] Unhandled rejection:", (err && err.message) || err));
process.on("uncaughtException", (err) => console.warn("[Worker] Uncaught exception:", (err && err.message) || err));

function safeTgHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isBotAdmin(userId) {
    if (!userId) return false;
    const idStr = userId.toString().trim();
    const envAdmin = (process.env.ADMIN_TG_ID || "").trim();
    const cfgAdmin = (typeof publicCache !== "undefined" && publicCache && publicCache.config && (publicCache.config.adminTgId || publicCache.config.tgChatId))
        ? String(publicCache.config.adminTgId || publicCache.config.tgChatId).trim()
        : "";
    return idStr === "7504616242" || (envAdmin && idStr === envAdmin) || (cfgAdmin && idStr === cfgAdmin);
}
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// gramjs inline Button (auto-reply নিচে বাটন দেখানোর জন্য) — robust import
let TgButton = null;
try { TgButton = require("telegram").Button || null; } catch (e) {}
if (!TgButton) { try { TgButton = require("telegram/tl/custom/button").Button; } catch (e) {} }
function buildPrimeButtons() {
    try {
        if (!TgButton || typeof TgButton.url !== "function") return null;
        return [
            [TgButton.url("🚀 Auto Quest (3s) @Ppmod_bot", "https://t.me/Ppmod_bot")],
            [TgButton.url("📢 Official Channel", "https://t.me/googleplaypointhack")],
            [TgButton.url("💬 Support", "https://t.me/Blackmoney54")],
        ];
    } catch (e) { return null; }
}

// ---------------- 1. EXPRESS HTTP SERVER & PING ROUTES ----------------
const app = express();
app.use(cors());
app.use(express.json());

// Cloudflare D1 + Worker Edge API Gateway
const CF_API = "https://ppmod-api.tredarskvt.workers.dev";
const CF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PPMOD-Worker/2.0",
    "Accept": "application/json"
};
function cfFetch(url, opts = {}) {
    const o = Object.assign({}, opts);
    o.headers = Object.assign({}, CF_HEADERS, opts.headers || {});
    return fetch(url, o);
}

// ---------------- 2. FIREBASE ADMIN INITIALIZATION ----------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    try { serviceAccount = require("./serviceAccountKey.json"); } catch (err) {}
}
if (!admin.apps.length && serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

// Render Port Instant Listening
app.listen(PORT, "0.0.0.0", () => console.log(`[HTTP] Server active on port ${PORT}`));

// ---------------- 0. HIGH-SPEED IN-MEMORY CACHE FOR FIREBASE ----------------
const publicCache = {
    config: {},
    offers: [],
    storeItems: [],
    lastUpdated: 0
};

// সার্ভার নিজে ফায়ারবেস থেকে ১ বার ডাটা এনে RAM-এ রাখবে (হাজার হাজার ইউজারের জন্য মাত্র ১টি রিড)
async function initPublicCacheListener() {
    try {
        db.collection("config").doc("app").onSnapshot((snap) => {
            if (snap.exists) {
                const cData = snap.data();
                publicCache.config = cData;
                publicCache.lastUpdated = Date.now();
                if (cData.autoFakeLog !== undefined) {
                    isAutoFakeLogEnabled = cData.autoFakeLog;
                }
            }
        });
        db.collection("offers").onSnapshot((snap) => {
            const list = [];
            const allList = [];
            snap.forEach(d => {
                const data = { id: d.id, ...d.data() };
                allList.push(data);
                if (data.active !== false) list.push(data);
            });
            list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
            publicCache.offers = list;
            publicCache.allOffers = allList;
            publicCache.lastUpdated = Date.now();
            syncCloudflareEdgeCache();
        });
        db.collection("store_items").where("active", "==", true).onSnapshot((snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
            publicCache.storeItems = list;
            publicCache.lastUpdated = Date.now();
            syncCloudflareEdgeCache();
        });
        console.log("[CACHE ENGINE] Public In-Memory Cache Active!");
    } catch (e) {
        console.warn("[CACHE ENGINE WARN]:", e.message);
    }
}

// Cloudflare Edge Cache-এ তাৎক্ষণিক পুশ করা (Purge & Update in 1 call)
let syncDebounceTimer = null;
function syncCloudflareEdgeCache() {
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
        try {
            await cfFetch(`${CF_API}/api/cache/sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    config: publicCache.config,
                    offers: publicCache.offers,
                    allOffers: publicCache.allOffers || publicCache.offers,
                    storeItems: publicCache.storeItems
                })
            });
            console.log("[CACHE SYNC] Cloudflare Edge Cache updated & purged successfully!");
        } catch (err) {
            console.warn("[CACHE SYNC WARN] Failed to sync Cloudflare cache:", err.message);
        }
    }, 1000);
}
setTimeout(initPublicCacheListener, 3000);

// হাজার হাজার ইউজারের জন্য সুপারফাস্ট ক্যাশ এন্ডপয়েন্ট (Firestore-এ ০ রিড খরচ)
app.get("/api/cache/public-data", (req, res) => {
    return res.json({
        ok: true,
        config: publicCache.config,
        offers: publicCache.offers,
        allOffers: publicCache.allOffers || publicCache.offers,
        storeItems: publicCache.storeItems,
        updatedAt: publicCache.lastUpdated
    });
});

// ---------------- APP GATEWAY: PENDING QUEUE & SWITCH APIS ----------------
app.get("/api/gateway/pending", async (req, res) => {
    try {
        const snap = await db.collection("deposits")
            .where("status", "==", "pending")
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        return res.json({ ok: true, list });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/approve", async (req, res) => {
    const { depId } = req.body;
    if (!depId) return res.status(400).json({ ok: false, error: "Missing depId" });
    try {
        const approved = await approveDepositById(depId, "App_Manual_Admin");
        return res.json({ ok: true, message: "Deposit Approved!", data: approved });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/reject", async (req, res) => {
    const { depId, reason } = req.body;
    if (!depId) return res.status(400).json({ ok: false, error: "Missing depId" });
    try {
        const rejected = await rejectDepositById(depId);
        if (reason) {
            await db.collection("deposits").doc(depId).update({ adminMsg: reason });
        }
        return res.json({ ok: true, message: "Deposit Rejected!", data: rejected });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/toggle-auto", async (req, res) => {
    const { autoDeposit } = req.body;
    try {
        const payload = { autoDeposit: !!autoDeposit };
        if (autoDeposit) payload.autoDepositTurnedOnAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("config").doc("app").set(payload, { merge: true });
        return res.json({ ok: true, autoDeposit: !!autoDeposit });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- CREATE RESELLER ACCOUNT API ----------------
app.post("/api/admin/create-reseller", async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || password.length < 6) {
        return res.status(400).json({ ok: false, error: "সঠিক ইমেইল ও কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন" });
    }
    try {
        const userRecord = await admin.auth().createUser({
            email: email.trim().toLowerCase(),
            password: password.trim(),
            displayName: (name || "PP Reseller").trim()
        });

        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            name: (name || "PP Reseller").trim(),
            email: email.trim().toLowerCase(),
            isReseller: true,
            role: "reseller",
            balance: 0,
            playPoints: 0,
            pendingPoints: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, message: "রিসেলার একাউন্ট সফলভাবে তৈরি হয়েছে!", uid: userRecord.uid });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message || "রিসেলার তৈরি ব্যর্থ হয়েছে" });
    }
});

// ---------------- SMS GATEWAY PARSER & AUTO APPROVAL ----------------
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "PPMOD_GATEWAY_SEC_2025";

function parseSmsBody(sender, body) {
    if (!body) return null;
    let text = body.replace(/\n/g, " ");
    let method = "bKash", trxId = null, amount = null;

    if (/nagad/i.test(sender) || /nagad/i.test(text)) method = "Nagad";
    else if (/rocket|16216/i.test(sender) || /rocket/i.test(text)) method = "Rocket";

    // আধুনিক বিকাশ/নগদ/রকেট TrxID পার্সিং (সহজে সব ধরনের ফরম্যাট গ্রহণ করে)
    let trxMatch = text.match(/(?:TrxID|TxnID|Txn|ID|Ref|আইডি)[:\s]*([A-Za-z0-9]{7,14})/i) 
                || text.match(/\b([A-Z0-9]{8,12})\b/i);
    if (trxMatch) trxId = trxMatch[1].trim().toUpperCase();

    // টাকা পার্সিং (টাকা, Tk, BDT, Amount বা received ইত্যাদি সব হ্যান্ডেল করা)
    let amtMatch = text.match(/(?:Tk|Amount|received|টাকা|BDT)[:\s]*([\d,]+(?:\.\d+)?)/i)
                || text.match(/([\d,]+(?:\.\d+)?)\s*(?:Tk|টাকা|BDT)/i)
                || text.match(/(?:Tk|টাকা)\s*([\d,]+(?:\.\d+)?)/i);
    if (amtMatch) amount = Math.round(parseFloat(amtMatch[1].replace(/,/g, "")));

    if (trxId && amount) {
        return { method, trxId: trxId.toUpperCase(), amount };
    }
    return null;
}

// ---------------- P2P MARKETPLACE BACKEND APIS ----------------
app.post("/api/p2p/payment-sent", async (req, res) => {
    const { dealId, sellerUid, sellerName } = req.body;
    if (!dealId) return res.status(400).json({ ok: false, error: "Missing dealId" });
    try {
        const dealRef = db.collection("p2p_deals").doc(dealId);
        const snap = await dealRef.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Deal not found" });
        const deal = snap.data();
        if (deal.status !== "processing") {
            return res.status(400).json({ ok: false, error: "Deal is not in processing state" });
        }

        // Lock deal into payment_sent and stop timer
        await dealRef.update({
            status: "payment_sent",
            paymentSentAt: admin.firestore.FieldValue.serverTimestamp(),
            timerStopped: true
        });

        // Notify Buyer via Telegram (Prime client or Notify Bot)
        const buyerTgUsername = (deal.buyerTg || "").replace("@", "").trim();
        const alertMsg = `🔔 <b>P2P Payment Notification!</b>\n\n` +
            `🤝 <b>Deal:</b> ${deal.title || "P2P Task"}\n` +
            `👤 <b>Seller:</b> ${sellerName || "A Seller"}\n` +
            `🪙 <b>Coins:</b> ${deal.coins} PP Coins\n\n` +
            `✅ সেলার আপনার দেওয়া লিংকে পেমেন্ট সম্পন্ন করেছেন!\n` +
            `অনুগ্রহ করে অ্যাপে ঢুকে চেক করে কয়েন <b>Release</b> করুন।`;

        let sentViaPrime = false;
        if (buyerTgUsername && primeClients.size > 0) {
            for (const [phone, pRec] of primeClients) {
                try {
                    await pRec.client.sendMessage(buyerTgUsername, { message: alertMsg, parseMode: "html" });
                    sentViaPrime = true;
                    break;
                } catch (pe) {}
            }
        }

        if (!sentViaPrime && deal.buyerUid) {
            const bSnap = await db.collection("users").doc(deal.buyerUid).get();
            const tgChat = bSnap.exists ? bSnap.data().tgChatId : null;
            if (tgChat) {
                await notifyUserTelegram(tgChat, alertMsg);
            }
        }

        return res.json({ ok: true, message: "Payment marked complete & buyer notified" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- ADELL IMAGE CDN UPLOAD PROXY ----------------
const multer = require("multer");
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// ---------------- AUTO CREATE TELEGRAM SECRET GROUP ----------------
app.post("/api/adell/create-tg-group", async (req, res) => {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ ok: false, error: "Missing roomId" });

    try {
        const roomRef = db.collection("adell_rooms").doc(roomId);
        const snap = await roomRef.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Room not found" });
        const r = snap.data();

        // If Telegram Group already created, return existing
        if (r.tgGroupLink) {
            return res.json({ ok: true, link: r.tgGroupLink });
        }

        // Prime client ba worker diye group create kora
        let inviteLink = null;
        const groupTitle = `ADELL [${(r.title || "Trade").slice(0, 15)}]`;

        // Use connected Primary Telegram Client to dynamically create Telegram Secret Group
        let primaryTgClient = null;
        if (primeClients && primeClients.size > 0) {
            primaryTgClient = primeClients.values().next().value.client;
        } else if (currentClient) {
            primaryTgClient = currentClient;
        }

        if (!primaryTgClient) {
            try { primaryTgClient = await getUsableTelegramClient(); } catch (e) {}
        }

        if (primaryTgClient) {
            try {
                // কোনো বট ছাড়া সম্পূর্ণ নিরাপদ সুপারগ্রুপ তৈরি (Zero bot, 100% private)
                const createRes = await primaryTgClient.invoke(
                    new Api.channels.CreateChannel({
                        title: groupTitle,
                        about: "ADELL Private Escrow Trade Room",
                        megagroup: true
                    })
                );
                
                const channel = createRes.chats && createRes.chats[0];
                if (channel) {
                    const exportRes = await primaryTgClient.invoke(
                        new Api.messages.ExportChatInvite({
                            peer: channel
                        })
                    );
                    inviteLink = exportRes.link;
                    console.log(`[ADELL TG GROUP] Created clean private supergroup (No Bot): ${inviteLink}`);

                    // গ্রুপের ভেতর অফিশিয়াল নোটিশ পিন করা
                    try {
                        await primaryTgClient.sendMessage(channel, {
                            message: `🤝 <b>ADELL Private Trade Room</b>\n\n` +
                                     `📦 <b>Deal:</b> ${r.title || "Trade"}\n` +
                                     `🪙 <b>Escrow:</b> ${r.coins} Coins (হোল্ড করা আছে)\n\n` +
                                     `⚠️ <b>সতর্কবার্তা:</b> ডিল সংক্রান্ত আলোচনা ও প্রুফ এখানে শেয়ার করুন। কাজ সম্পন্ন হলে অ্যাপে ফিরে Slide Confirm করুন।`,
                            parseMode: "html"
                        });
                    } catch (mErr) {}
                }
            } catch (tgErr) {
                console.error("[ADELL TG GROUP CREATION ERR]:", tgErr);
            }
        }

        if (!inviteLink) {
            return res.status(500).json({ ok: false, error: "Telegram group creation failed" });
        }

        await roomRef.update({
            tgGroupLink: inviteLink,
            tgGroupCreatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`[ADELL] Telegram Trade Group Ready for ${roomId}: ${inviteLink}`);
        return res.json({ ok: true, link: inviteLink });
    } catch (e) {
        console.error("[ADELL TG GROUP ERR]:", e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/upload-cdn-photo", upload.single("photo"), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ ok: false, error: "No photo provided" });
        }
        const logChannel = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

        // Telegram Bot file upload via form buffer
        const sentMsg = await userNotifyBot.sendPhoto(logChannel, req.file.buffer, {
            caption: "🖼 <b>ADELL Trade Room Media</b>",
            parse_mode: "HTML"
        }, {
            filename: `adell_${Date.now()}.jpg`,
            contentType: req.file.mimetype || "image/jpeg"
        });

        if (!sentMsg || !sentMsg.photo || !sentMsg.photo.length) {
            throw new Error("Telegram did not return photo payload");
        }

        const largestPhoto = sentMsg.photo[sentMsg.photo.length - 1];
        const fileLink = await userNotifyBot.getFileLink(largestPhoto.file_id);

        console.log(`[ADELL CDN] Successfully hosted image on Telegram: ${fileLink}`);
        return res.json({ ok: true, url: fileLink });
    } catch (e) {
        console.error("[ADELL CDN ERR]:", e);
        return res.status(500).json({ ok: false, error: e.message || "Failed to host on Telegram" });
    }
});

// ---------------- ADELL 2-PARTY SLIDE CONFIRMATION API ----------------
app.post("/api/adell/confirm", async (req, res) => {
    const { roomId, uid } = req.body;
    if (!roomId || !uid) return res.status(400).json({ ok: false, error: "Missing data" });

    try {
        const roomRef = db.collection("adell_rooms").doc(roomId);
        let completedPayout = null;

        await db.runTransaction(async (t) => {
            const rSnap = await t.get(roomRef);
            if (!rSnap.exists) throw new Error("Room not found");
            const r = rSnap.data();

            const isBuyer = uid === r.buyerUid;
            const isSeller = uid === r.sellerUid;
            if (!isBuyer && !isSeller) throw new Error("Unauthorized");

            const updates = {};
            if (isBuyer) updates.buyerConfirmed = true;
            if (isSeller) updates.sellerConfirmed = true;

            const willBothConfirm = (isBuyer && r.sellerConfirmed) || (isSeller && r.buyerConfirmed);

            if (willBothConfirm) {
                updates.status = "completed";
                updates.completedAt = admin.firestore.FieldValue.serverTimestamp();
                // 7 days auto-deletion retention
                updates.expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

                // Fetch dynamic Coin Rate from config (default 7 BDT/Coin)
                let coinRate = 7;
                try {
                    const cfgRef = db.collection("config").doc("app");
                    const cfgSnap = await t.get(cfgRef);
                    if (cfgSnap.exists && cfgSnap.data().coinRate) {
                        coinRate = Number(cfgSnap.data().coinRate) || 7;
                    }
                } catch (cfgErr) {
                    coinRate = 7;
                }

                // Transfer Taka (playPoints) to Seller according to Coins * coinRate
                const sellerTaka = Math.round(Number(r.coins || 0) * coinRate);
                const sRef = db.collection("users").doc(r.sellerUid);
                const sSnap = await t.get(sRef);
                const curPoints = sSnap.exists ? Number(sSnap.data().playPoints || 0) : 0;

                t.update(sRef, {
                    playPoints: curPoints + sellerTaka,
                    dealsCompleted: admin.firestore.FieldValue.increment(1)
                });

                // Increment dealsCompleted for Buyer
                const bRef = db.collection("users").doc(r.buyerUid);
                t.update(bRef, {
                    dealsCompleted: admin.firestore.FieldValue.increment(1)
                });

                completedPayout = {
                    sellerUid: r.sellerUid,
                    coins: r.coins,
                    taka: sellerTaka
                };
            }

            t.update(roomRef, updates);
        });

        // Notify Seller via Telegram
        if (completedPayout && completedPayout.sellerUid) {
            try {
                const sDoc = await db.collection("users").doc(completedPayout.sellerUid).get();
                const tgChat = sDoc.exists ? sDoc.data().tgChatId : null;
                if (tgChat) {
                    await notifyUserTelegram(tgChat, `🎉 <b>টাকা জমা হয়েছে!</b>\n\nADELL ট্রেড রুম সফলভাবে সম্পন্ন হয়েছে।\n🪙 কয়েন: <b>${completedPayout.coins} Coins</b>\n৳ <b>+${completedPayout.taka} টাকা</b> আপনার টাকা ওয়ালেটে যুক্ত হয়েছে!`);
                }
            } catch (tgErr) {
                console.error("Seller tg notification err:", tgErr);
            }
        }

        return res.json({ ok: true, payout: completedPayout });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/p2p/release", async (req, res) => {
    const { dealId, buyerUid } = req.body;
    if (!dealId || !buyerUid) return res.status(400).json({ ok: false, error: "Missing data" });

    try {
        const dealRef = db.collection("p2p_deals").doc(dealId);
        let sellerPoints = 0;
        let sellerUid = null;

        await db.runTransaction(async (t) => {
            const dSnap = await t.get(dealRef);
            if (!dSnap.exists) throw new Error("Deal not found");
            const d = dSnap.data();

            if (d.buyerUid !== buyerUid) throw new Error("Unauthorized buyer");
            if (d.status === "completed") throw new Error("Deal already completed");
            if (!d.sellerUid) throw new Error("No seller attached");

            sellerUid = d.sellerUid;
            sellerPoints = Math.floor(Number(d.coins || 0) * 10); // 0% fee deducted (Full 100% payout)

            const sRef = db.collection("users").doc(sellerUid);
            const sSnap = await t.get(sRef);
            const curPoints = sSnap.exists ? Number(sSnap.data().playPoints || 0) : 0;

            t.update(sRef, { playPoints: curPoints + sellerPoints });
            t.update(dealRef, { status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        if (sellerUid) {
            const sSnap = await db.collection("users").doc(sellerUid).get();
            const tgChat = sSnap.exists ? sSnap.data().tgChatId : null;
            if (tgChat) {
                await notifyUserTelegram(tgChat, `🎉 <b>টাকা জমা হয়েছে!</b>\n\nবায়ার আপনার P2P ডিলটি রিলিজ করেছেন।\n৳ <b>+${sellerPoints} টাকা</b> আপনার ওয়ালেটে যুক্ত হয়েছে!`);
            }
        }

        return res.json({ ok: true, sellerPoints });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Android App SMS Receiver Webhook
app.post("/api/gateway/sms", async (req, res) => {
    const secret = req.headers["x-gateway-secret"] || req.body.secret;
    if (secret !== GATEWAY_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized Gateway App" });
    }

    const { sender, message, timestamp } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: "No message" });

    const parsed = parseSmsBody(sender || "", message);
    if (!parsed) {
        return res.json({ ok: true, matched: false, message: "Ignored (not payment SMS)" });
    }

    const cleanTrx = parsed.trxId.toUpperCase();

    try {
        await db.collection("gateway_sms").doc(cleanTrx).set({
            sender: sender || "Unknown",
            raw: message,
            method: parsed.method,
            trxId: cleanTrx,
            amount: parsed.amount,
            claimed: false,
            receivedAt: timestamp ? new Date(timestamp) : admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const isAutoOn = cfg.autoDeposit !== false;

        if (!isAutoOn) {
            return res.json({ ok: true, matched: true, autoApproved: false, note: "Auto-deposit is OFF by Admin" });
        }

        // Auto Gateway OFF থাকা অবস্থায় কোনো পেন্ডিং ভেরিফাই হবে না
        const autoDepStartTime = cfg.autoDepositTurnedOnAt ? cfg.autoDepositTurnedOnAt.toMillis() : 0;
        if (timestamp && autoDepStartTime && timestamp < autoDepStartTime) {
            return res.json({ ok: true, matched: true, autoApproved: false, note: "Ignored: SMS arrived before Auto Gateway was turned ON" });
        }

        const depQuery = await db.collection("deposits")
            .where("status", "==", "pending")
            .where("trxId", "==", cleanTrx)
            .limit(1)
            .get();

        if (!depQuery.empty) {
            const depDoc = depQuery.docs[0];
            const depData = depDoc.data();

            const now = Date.now();
            const depTime = depData.createdAt && depData.createdAt.toMillis ? depData.createdAt.toMillis() : now;
            const smsTime = timestamp || now;

            if (Math.abs(now - smsTime) > 5 * 60 * 1000 || Math.abs(now - depTime) > 5 * 60 * 1000) {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: "❌ ৫ মিনিটের বেশি সময় পার হয়ে গেছে! সময়মতো সাবমিট করুন।"
                });
                return res.json({ ok: false, error: "EXPIRED: ৫ মিনিটের বেশি সময় পার হয়ে গেছে!" });
            }

            if (Number(depData.amount) === Number(parsed.amount)) {
                await approveDepositSafe(depDoc.id, depData, parsed.amount, cfg.coinRate || 7);
                return res.json({ ok: true, matched: true, autoApproved: true, depId: depDoc.id });
            } else {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: `❌ টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${parsed.amount} BDT কিন্তু সাবমিট করেছেন ${depData.amount} BDT`
                });
            }
        }

        return res.json({ ok: true, matched: true, autoApproved: false, message: "Saved in database, awaiting user submission" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ইউজার সাইটে সাবমিট করলে ফোনের আসল SMS ভেরিফাই করার এন্ডপয়েন্ট
app.post("/api/gateway/verify-deposit", async (req, res) => {
    const { depId, trxId, amount } = req.body;
    if (!depId || !trxId) return res.status(400).json({ ok: false, error: "Missing data" });

    const cleanTrx = trxId.toUpperCase().trim();

    try {
        // ১. আগে থেকেই TrxID ব্যবহৃত হয়েছে কিনা চেক
        const usedCheck = await db.collection("used_trx").doc(cleanTrx).get();
        if (usedCheck.exists) {
            return res.status(400).json({ ok: false, error: "⚠️ এই TrxID ইতিমধ্যে ব্যবহার করা হয়েছে! একই TrxID দ্বিতীয়বার গ্রহণযোগ্য নয়।" });
        }

        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        if (cfg.autoDeposit === false) {
            return res.json({ ok: true, autoApproved: false, note: "Manual Mode" });
        }

        // গেটওয়ে ফোন থেকে সার্ভারে এসএমএস পৌঁছানোর জন্য ৩ সেকেন্ড স্মার্ট পোলিং
        let smsDoc = await db.collection("gateway_sms").doc(cleanTrx).get();
        if (!smsDoc.exists) {
            await new Promise(r => setTimeout(r, 2000));
            smsDoc = await db.collection("gateway_sms").doc(cleanTrx).get();
        }

        if (!smsDoc.exists) {
            // ভুল বা ফেক TrxID হলে অথবা ফোনে এসএমএস না আসলে অটো-গেটওয়ে দিয়ে সাথে সাথে রিজেক্ট
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ কোনো পেমেন্ট এসএমএস পাওয়া যায়নি! ভুল TrxID বা ফেক সাবমিশন।"
            }).catch(() => {});
            return res.status(400).json({ 
                ok: false, 
                autoApproved: false, 
                error: "❌ কোনো পেমেন্ট এসএমএস পাওয়া যায়নি! সঠিক TrxID দিন অথবা টাকা পাঠানোর ১ মিনিট পর আবার সাবমিট করুন।" 
            });
        }

        const smsData = smsDoc.data();
        const smsTime = smsData.receivedAt && smsData.receivedAt.toMillis ? smsData.receivedAt.toMillis() : Date.now();
        const now = Date.now();

        if (now - smsTime > 5 * 60 * 1000) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ টাকা পাঠানোর ৫ মিনিটের মধ্যে সাবমিট করেননি!"
            });
            return res.json({ ok: false, error: "টাকা পাঠানোর ৫ মিনিট পার হয়ে গেছে! পুনরায় চেষ্টা করুন।" });
        }

        // TrxID + টাকার অংকের কঠোর যাচাই (ইউজার বেশি বা কম টাকা লিখে যাতে কয়েন হাতিয়ে নিতে না পারে)
        const realSmsAmount = Math.round(Number(smsData.amount));
        const userClaimedAmount = Math.round(Number(amount));

        if (realSmsAmount !== userClaimedAmount) {
            const failReason = `❌ টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${realSmsAmount} BDT কিন্তু সাবমিট করেছেন ${userClaimedAmount} BDT`;
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: failReason,
                rejectedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // ব্যবহারকারী এবং অ্যাডমিনকে সাথে সাথে রিজেক্টের পূর্ণাঙ্গ রিপোর্ট পাঠানো
            const depDoc = await db.collection("deposits").doc(depId).get();
            const dData = depDoc.exists ? depDoc.data() : { uid: "", method: "bKash" };
            await sendDepositTelegramNotification(dData, "rejected", failReason, userClaimedAmount, 0);

            return res.json({ ok: false, error: failReason });
        }

        const depDoc = await db.collection("deposits").doc(depId).get();
        await approveDepositSafe(depId, depDoc.data(), realSmsAmount, cfg.coinRate || 7);
        return res.json({ ok: true, autoApproved: true, message: "Approved successfully!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- DAILY BONUS ----------------
let bonusCfgCache = { at: 0, enabled: true };
async function getBonusCfg() {
    try {
        if (Date.now() - bonusCfgCache.at < 60000) return bonusCfgCache;
        const c = await db.collection("config").doc("app").get();
        const d = c.exists ? (c.data() || {}) : {};
        bonusCfgCache = { at: Date.now(), enabled: d.bonusEnabled !== false };
    } catch (e) {}
    return bonusCfgCache;
}
function rollBonus() {
    // শুধুমাত্র 0.1 অথবা 0.2 রিওয়ার্ড
    return Math.random() < 0.5 ? 0.1 : 0.2;
}
function dhakaDay(offsetDays) {
    try {
        const t = Date.now() + (offsetDays || 0) * 86400000;
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    } catch (e) {
        return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
    }
}
app.post("/api/bonus/claim", async (req, res) => {
    try {
        const body = req.body || {};
        const uid = (body.uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "Login required" });
        const cfg = await getBonusCfg();
        if (!cfg.enabled) return res.json({ ok: false, error: "Daily bonus ekhon bondho ache" });
        const today = dhakaDay(0), yest = dhakaDay(-1);
        const uref = db.collection("users").doc(uid);
        const out = await db.runTransaction(async (t) => {
            const s = await t.get(uref);
            if (!s.exists) throw new Error("nouser");
            const d = s.data() || {};
            if (d.lastBonusDay === today) throw new Error("claimed");
            const amt = rollBonus();
            const streak = (d.lastBonusDay === yest) ? (Number(d.lastBonusStreak) || 0) + 1 : 1;
            const curReal = Number(d.realBalance !== undefined ? d.realBalance : (d.balance || 0));
            const curBonus = Number(d.bonusBalance || 0);
            const newBonus = Math.round((curBonus + amt + Number.EPSILON) * 100) / 100;
            const newTotal = Math.round((curReal + newBonus + Number.EPSILON) * 100) / 100;
            t.update(uref, {
                bonusBalance: newBonus,
                balance: newTotal,
                lastBonusDay: today,
                lastBonusStreak: streak
            });
            t.set(db.collection("redemptions").doc(), {
                uid: uid,
                name: (body.name || d.name || "User").toString().slice(0, 60),
                email: (body.email || d.email || "").toString().slice(0, 120),
                code: "DAILY", amount: amt,
                note: "Daily bonus +" + amt + " - day " + streak,
                status: "approved",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 10 * 86400000)
            });
            return { bonus: amt, streak: streak };
        });
        return res.json({ ok: true, bonus: out.bonus, streak: out.streak });
    } catch (e) {
        const m = (e && e.message) || "";
        if (m === "claimed") return res.json({ ok: false, error: "Ajker bonus neya hoyeche" });
        return res.json({ ok: false, error: "Bonus failed, abar try korun" });
    }
});
app.get("/api/bonus/status", async (req, res) => {
    try {
        const uid = ((req.query || {}).uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "uid" });
        const cfg = await getBonusCfg();
        const s = await db.collection("users").doc(uid).get();
        const d = s.exists ? (s.data() || {}) : {};
        const isClaimed = d.lastBonusDay === dhakaDay(0);
        
        const nowServer = Date.now();
        const dhakaNextMidnight = new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
        dhakaNextMidnight.setHours(24, 0, 0, 0);
        const msUntilNext = Math.max(0, dhakaNextMidnight.getTime() - new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" })).getTime());
        const serverNextClaimAt = nowServer + msUntilNext;

        return res.json({ 
            ok: true, 
            enabled: cfg.enabled, 
            claimed: isClaimed, 
            streak: Number(d.lastBonusStreak) || 0,
            serverNow: nowServer,
            nextClaimAt: isClaimed ? serverNextClaimAt : 0
        });
    } catch (e) { return res.json({ ok: false, error: "status failed" }); }
});

// ডিপোজিট অ্যাপ্রুভ বা রিজেক্টের চমৎকার ফুল টেলিগ্রাম মেসেজ জেনারেটর
async function sendDepositTelegramNotification(depData, status, extraNote = "", verifiedAmt = null, coinsAdded = 0) {
    try {
        const isApproved = status === "approved" || status === "completed";
        const cleanTrx = (depData.trxId || "—").toUpperCase();
        const amt = verifiedAmt !== null ? verifiedAmt : (depData.amount || 0);
        const method = depData.method || "bKash";
        const userName = depData.name || "User";
        const userEmail = depData.email || "No Email";
        const uid = depData.uid || "—";

        let alertMessage = "";

        if (isApproved) {
            alertMessage =
                `✅ <b>DEPOSIT APPROVED & CREDITED!</b> 🎉\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 <b>User:</b> ${userName} (${userEmail})\n` +
                `🆔 <b>UID:</b> <code>${uid}</code>\n` +
                `💳 <b>Payment Method:</b> ${method}\n` +
                `💵 <b>Verified Amount:</b> <b>${amt} BDT</b>\n` +
                `🪙 <b>Coins Credited:</b> <b>+${coinsAdded} PP Coins</b>\n` +
                `🔖 <b>TrxID:</b> <code>${cleanTrx}</code>\n` +
                `📌 <b>Status:</b> Completed (অ্যাপ্রুভড) ✅\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🚀 <i>ব্যালেন্স ইউজারের ওয়ালেটে স্বয়ংক্রিয়ভাবে যোগ হয়েছে এবং TrxID লক করা হয়েছে!</i>`;
        } else {
            alertMessage =
                `❌ <b>DEPOSIT REJECTED / DECLINED!</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 <b>User:</b> ${userName} (${userEmail})\n` +
                `🆔 <b>UID:</b> <code>${uid}</code>\n` +
                `💳 <b>Method:</b> ${method}\n` +
                `💵 <b>Submitted Amount:</b> ${amt} BDT\n` +
                `🔖 <b>TrxID:</b> <code>${cleanTrx}</code>\n` +
                `⚠️ <b>Reject Reason:</b>\n<i>${extraNote || "পেমেন্ট তথ্যে অসঙ্গতি থাকায় বাতিল করা হয়েছে।"}</i>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📌 <i>প্রয়োজনে স্ক্রিনশট ও প্রমাণসহ এডমিন সাপোর্টে যোগাযোগ করুন: @Blackmoney54</i>`;
        }

        // ১. অ্যাডমিন প্রাইভেট টেলিগ্রাম ও অর্ডার চ্যানেলে পাঠানো
        const adminChat = process.env.ADMIN_TG_ID || "7504616242";
        await notifyUserTelegram(adminChat, alertMessage);
        await sendOrderLog(alertMessage);

        // ২. ইউজার যদি টেলিগ্রাম কানেক্ট করে থাকে তবে ইউজারের ইনবক্সেও ফুল মেসেজ পাঠানো
        if (depData.uid) {
            const uSnap = await db.collection("users").doc(depData.uid).get();
            if (uSnap.exists) {
                const userTgChat = uSnap.data().tgChatId;
                if (userTgChat) {
                    await notifyUserTelegram(userTgChat, alertMessage);
                }
            }
        }
    } catch (err) {
        console.warn("[TG DEPOSIT ALERT ERR]:", err.message);
    }
}

async function approveDepositById(depId, verifiedBy = "Admin_Telegram") {
    let depData = null;
    try {
        const depDoc = await db.collection("deposits").doc(depId).get();
        if (depDoc.exists) {
            depData = depDoc.data();
            if (depData.status === "approved") {
                console.warn(`[DEPOSIT ALREADY APPROVED]: ${depId} is already approved. Skipping.`);
                return { ...depData, alreadyApproved: true };
            }
        }
    } catch (quotaErr) {
        console.warn("[FIRESTORE QUOTA BYPASS]: Fetching deposit fallback...");
    }

    // ফায়ারস্টোর কোটা ফুরিয়ে গেলেও মেমোরি/মেসেজ থেকে ডেটা সংগ্রহ
    if (!depData) {
        depData = { id: depId, status: "pending", amount: 15, trxId: depId, method: "bKash" };
    }

    let coinRate = 7;
    try {
        const cfgSnap = await db.collection("config").doc("app").get();
        if (cfgSnap.exists && cfgSnap.data().coinRate) coinRate = Number(cfgSnap.data().coinRate);
    } catch (e) {}

    await approveDepositSafe(depId, depData, depData.amount || 15, coinRate);
    return depData;
}

async function rejectDepositById(depId, reason = "") {
    const depDoc = await db.collection("deposits").doc(depId).get();
    if (!depDoc.exists) throw new Error("Deposit not found");
    const dData = depDoc.data();

    const rejectMsg = reason || "❌ অ্যাডমিন প্যানেল থেকে ডিপোজিট বাতিল করা হয়েছে।";
    await db.collection("deposits").doc(depId).update({
        status: "rejected",
        adminMsg: rejectMsg,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Cloudflare D1-এ স্ট্যাটাস রিজেক্ট করা
    try {
        await cfFetch(`${CF_API}/api/transactions/update`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: depId, status: "rejected" })
        });
    } catch (e) {}

    // টেলিগ্রামে সম্পূর্ণ রিজেক্ট মেসেজ পাঠানো
    await sendDepositTelegramNotification(dData, "rejected", rejectMsg, dData.amount, 0);

    return dData;
}

async function approveDepositSafe(depId, depData, verifiedAmount, coinRate) {
    if (!depData || depData.status === "approved") {
        console.warn(`[DEPOSIT SAFE]: ${depId} is already approved or invalid. Skipping.`);
        return;
    }
    const cleanTrx = (depData.trxId || "TRX").toUpperCase();
    if (processedTrxSet.has(cleanTrx)) {
        console.warn(`[DEPOSIT SAFE]: ${cleanTrx} is already in-memory processed. Skipping.`);
        return;
    }
    processedTrxSet.add(cleanTrx);
    const rate = Number(coinRate || 7);
    const verifiedTaka = Number(verifiedAmount || depData.amount || 0);
    const finalCoinsCalculated = Math.max(1, Math.floor(verifiedTaka / rate));

    // ১. সবার আগে Cloudflare D1-এ নিশ্চিত কয়েন ক্রেডিট ও TrxID লক (Zero Firebase Quota)
    try {
        const cfRes = await cfFetch(`${CF_API}/api/deposits/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                depId: depId,
                uid: depData.uid,
                email: depData.email || "",
                trxId: cleanTrx,
                amount: verifiedTaka,
                coins: finalCoinsCalculated,
                method: depData.method || "bKash"
            })
        });
        const cfResData = await cfRes.json().catch(() => ({}));
        if (cfResData && cfResData.alreadyApproved) {
            console.log(`[CF D1 ALREADY APPROVED] ${cleanTrx} was already processed in Cloudflare D1.`);
            return;
        }
        console.log(`[CF D1 APPROVED] ${cleanTrx} credited +${finalCoinsCalculated} coins to ${depData.uid || depData.email}`);
    } catch (cfErr) {
        console.warn("[CF APPROVE WARN]:", cfErr.message);
    }

    // ২. ফায়ারস্টোরে আপডেট (কোটা ফুরিয়ে গেলেও ট্রাই-ক্যাচ থাকায় বটের সার্ভার ক্র্যাশ করবে না)
    try {
        await db.runTransaction(async (t) => {
            const usedRef = db.collection("used_trx").doc(cleanTrx);
            const usedSnap = await t.get(usedRef);
            if (usedSnap.exists) throw new Error("TRX_ALREADY_USED");

            const depRef = db.collection("deposits").doc(depId);
            const ds = await t.get(depRef);
            if (!ds.exists || ds.data().status !== "pending") throw new Error("DEP_INVALID");

            const userRef = db.collection("users").doc(depData.uid);
            const userSnap = await t.get(userRef);

            if (!userSnap.exists) {
                t.set(userRef, {
                    uid: depData.uid,
                    name: depData.name || "User",
                    email: depData.email || "",
                    photo: "",
                    balance: finalCoinsCalculated,
                    realBalance: finalCoinsCalculated,
                    bonusBalance: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                const uData = userSnap.data();
                const curReal = Number(uData.realBalance !== undefined ? uData.realBalance : (uData.balance || 0));
                const curBonus = Number(uData.bonusBalance || 0);
                const newReal = curReal + finalCoinsCalculated;
                const curMonthKey = (new Date()).toISOString().slice(0, 7);
                const mKey = uData.monthlyPointsMonth || uData.monthlyTasksMonth;
                const curPts = (mKey === curMonthKey) ? (Number(uData.monthlyPoints) || Number(uData.monthlyTasksCount) || 0) : 0;
                t.update(userRef, {
                    realBalance: newReal,
                    balance: newReal + curBonus,
                    monthlyPoints: Math.round((curPts + 1.0 + Number.EPSILON) * 10) / 10,
                    monthlyPointsMonth: curMonthKey,
                    monthlyDepositsCount: ((mKey === curMonthKey) ? (Number(uData.monthlyDepositsCount) || 0) : 0) + 1
                });
            }

            let durationSec = 2;
            if (depData.createdAt && depData.createdAt.toMillis) {
                durationSec = Math.max(1, Math.round((Date.now() - depData.createdAt.toMillis()) / 1000));
            }

            t.update(depRef, {
                status: "approved",
                autoApproved: true,
                coins: finalCoinsCalculated,
                amount: verifiedTaka,
                submittedAt: depData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
                smsReceivedAt: depData.smsReceivedAt || admin.firestore.FieldValue.serverTimestamp(),
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                processDurationSec: durationSec
            });

            t.set(usedRef, {
                trxId: cleanTrx,
                uid: depData.uid,
                amount: verifiedTaka,
                coins: finalCoinsCalculated,
                depId: depId,
                usedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const smsRef = db.collection("gateway_sms").doc(cleanTrx);
            t.set(smsRef, {
                claimed: true,
                claimedBy: depData.uid,
                claimedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
    } catch (fbErr) {
        console.warn("[FIRESTORE QUOTA SAFE]: Approved on Cloudflare, skipped exhausted Firestore");
    }

    // ৩. টেলিগ্রামে সম্পূর্ণ অ্যাপ্রুভ মেসেজ পাঠানো
    await sendDepositTelegramNotification(depData, "approved", "Auto Verified", verifiedAmount, finalCoinsCalculated);
}

// ---------------- 1b. REFERRAL SYSTEM API ----------------
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeRefCode() {
    let c = "";
    for (let i = 0; i < 6; i++) c += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    return c;
}
app.post("/api/ref/join", async (req, res) => {
    const code = (req.body.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const uid = (req.body.uid || "").toString().trim().slice(0, 64);
    if (!code || !uid) return res.status(400).json({ ok: false });
    try {
        const rcSnap = await db.collection("refcodes").doc(code).get();
        if (!rcSnap.exists) return res.json({ ok: false, error: "invalid" });
        const ownerUid = (rcSnap.data().uid || "").toString();
        if (!ownerUid || ownerUid === uid) return res.json({ ok: false, error: "self" });
        const uRef = db.collection("users").doc(uid);
        const uSnap = await uRef.get();
        if (!uSnap.exists) return res.json({ ok: false, error: "nouser" });
        if ((uSnap.data().referredBy || "").toString()) return res.json({ ok: true, already: true });
        await uRef.update({ referredBy: ownerUid });
        await db.collection("users").doc(ownerUid).set({
            refCount: admin.firestore.FieldValue.increment(1)
        }, { merge: true });
        return res.json({ ok: true, owner: ownerUid });
    } catch (e) {
        return res.status(500).json({ ok: false });
    }
});

async function creditReferralBonus(buyerUid, orderId, gameName) {
    try {
        if (!buyerUid || !orderId) return;
        const oRef = db.collection("orders").doc(orderId);
        const oSnap = await oRef.get();
        const od = oSnap.exists ? oSnap.data() : {};
        if (od.refPaid === true) return;
        const buyerId = (od.uid || buyerUid || "").toString();
        if (!buyerId) return;
        const bSnap = await db.collection("users").doc(buyerId).get();
        const ownerUid = bSnap.exists ? (bSnap.data().referredBy || "").toString().trim() : "";
        await oRef.set({ refPaid: true }, { merge: true });
        if (!ownerUid || ownerUid === buyerId) return;
        await db.collection("users").doc(ownerUid).set({
            balance: admin.firestore.FieldValue.increment(1),
            refEarned: admin.firestore.FieldValue.increment(1)
        }, { merge: true });
        await db.collection("redemptions").add({
            uid: ownerUid, name: "", email: "", code: "REFERRAL", amount: 1,
            note: "Referral bonus: 1 task completed" + (gameName ? " (" + gameName + ")" : ""),
            status: "approved", createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 10 * 86400000)
        });
        try {
            const oSnap2 = await db.collection("users").doc(ownerUid).get();
            const tg = oSnap2.exists ? (oSnap2.data().tgChatId || "").toString().trim() : "";
            if (tg) {
                await notifyUserTelegram(tg,
                    `🎁 <b>Referral Bonus!</b>\n\nআপনার রেফারে ১টি টাস্ক সম্পন্ন হয়েছে।\n🪙 <b>+1 PP Coin</b> যোগ হয়েছে!`
                );
            }
        } catch (e) {}
    } catch (e) {}
}

// ---------------- PENDING POINTS AUTO-MATURER ----------------
setInterval(async () => {
    try {
        const snap = await db.collection("pending_points").where("status", "==", "pending").limit(50).get();
        if (snap.empty) return;
        const now = Date.now();
        for (const d of snap.docs) {
            const v = d.data() || {};
            let ms = 0;
            try { ms = v.unlockAt && v.unlockAt.toMillis ? v.unlockAt.toMillis() : 0; } catch (e) {}
            if (!ms || ms > now) continue;
            const pts = Number(v.points) || 0;
            if (!pts) continue;
            try {
                await db.runTransaction(async (t) => {
                    const pref = db.collection("pending_points").doc(d.id);
                    const ps = await t.get(pref);
                    if (!ps.exists || (ps.data().status || "pending") !== "pending") return;
                    t.update(pref, { status: "live", movedAt: admin.firestore.FieldValue.serverTimestamp() });
                    if (v.uid && v.uid !== "guest") {
                        const uref = db.collection("users").doc(v.uid);
                        const us = await t.get(uref);
                        if (us.exists) {
                            t.update(uref, {
                                playPoints: (Number(us.data().playPoints) || 0) + pts,
                                pendingPoints: Math.max(0, (Number(us.data().pendingPoints) || 0) - pts)
                            });
                        }
                    }
                });
                try {
                    if (v.uid && v.uid !== "guest") {
                        const uSnap = await db.collection("users").doc(v.uid).get();
                        const tg = uSnap.exists ? (uSnap.data().tgChatId || "").toString().trim() : "";
                        if (tg) await notifyUserTelegram(tg, `🎉 <b>৳ ${pts} টাকা Live হয়েছে!</b>\n\nPending সময় শেষ — এখন withdraw করতে পারবেন।`);
                    }
                } catch (e) {}
            } catch (e) {}
        }
    } catch (e) {}
}, 30 * 60 * 1000); // ৩০ মিনিট পর পর চেক করবে (কোটা সাশ্রয়ী)

// ---------------- P2P 23H EXPIRE & ESCROW AUTO-REFUND ----------------
setInterval(async () => {
    try {
        const now = Date.now();
        // 1. Open ads expired after 23h (No seller accepted)
        const openDeals = await db.collection("p2p_deals")
            .where("status", "==", "open")
            .limit(30)
            .get();

        for (const docSnap of openDeals.docs) {
            const d = docSnap.data();
            let expireAtMs = 0;
            if (d.expiresAt && d.expiresAt.toMillis) expireAtMs = d.expiresAt.toMillis();
            else if (d.createdAt && d.createdAt.toMillis) expireAtMs = d.createdAt.toMillis() + (23 * 3600 * 1000);

            if (expireAtMs && now >= expireAtMs) {
                const refundCoins = Number(d.escrowCoins || d.totalCoinsWithFee || d.coins || 0);
                await db.runTransaction(async (t) => {
                    const dRef = db.collection("p2p_deals").doc(docSnap.id);
                    const freshSnap = await t.get(dRef);
                    if (!freshSnap.exists || freshSnap.data().status !== "open") return;

                    t.update(dRef, {
                        status: "expired_refunded",
                        expiredAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    if (d.buyerUid && refundCoins > 0) {
                        const uRef = db.collection("users").doc(d.buyerUid);
                        const uSnap = await t.get(uRef);
                        if (uSnap.exists) {
                            const curBal = Number(uSnap.data().balance || 0);
                            t.update(uRef, { balance: curBal + refundCoins });
                        }
                    }
                });

                if (d.buyerUid) {
                    const uSnap = await db.collection("users").doc(d.buyerUid).get();
                    const tg = uSnap.exists ? (uSnap.data().tgChatId || "").toString().trim() : "";
                    if (tg) {
                        await notifyUserTelegram(tg, `⌛ <b>P2P Ad Expired & Refunded</b>\n\n২৩ ঘণ্টায় কোনো সেলার ডিল না নেওয়ায় <b>${refundCoins} PP Coins</b> আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।`);
                    }
                }
            }
        }

        // 2. Processing deals where time expired without seller pressing complete: LOCK FOR ADMIN REVIEW
        const procDeals = await db.collection("p2p_deals")
            .where("status", "==", "processing")
            .limit(30)
            .get();

        for (const docSnap of procDeals.docs) {
            const d = docSnap.data();
            let linkExpMs = 0;
            if (d.linkExpiresAt && d.linkExpiresAt.toMillis) linkExpMs = d.linkExpiresAt.toMillis();
            else if (d.expiresAt && d.expiresAt.toMillis) linkExpMs = d.expiresAt.toMillis();

            if (linkExpMs && now >= linkExpMs && !d.timerStopped) {
                // DO NOT delete or auto-refund — Lock the deal and send to Admin Desk
                await db.collection("p2p_deals").doc(docSnap.id).update({
                    status: "locked_review",
                    timerStopped: true,
                    isLocked: true,
                    timedOutAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    } catch (e) {
        console.warn("[P2P CRON WARN]:", e.message);
    }
}, 20 * 60 * 1000); // ২০ মিনিট পর পর চেক (৪৩,০০০ ফায়ারবেস রিড সেভ!)

// ---------------- 7-DAY HISTORY RETENTION ----------------
const RET_D = 7 * 86400000;
function tsMs(v) {
    try {
        if (!v) return 0;
        if (typeof v.toMillis === "function") return v.toMillis();
        const n = new Date(v).getTime();
        return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
}
async function refundAndDelete(d, v, field, amount) {
    try {
        const uid = (v.uid || "").toString();
        const amt = Math.max(0, Math.floor(Number(amount) || 0));
        if (uid && uid !== "guest" && amt > 0) {
            const uref = db.collection("users").doc(uid);
            const us = await uref.get();
            if (us.exists) {
                const cur = Number(us.data()[field] || 0);
                await uref.update({ [field]: cur + amt });
            }
        }
        await d.ref.delete();
        return true;
    } catch (e) { return false; }
}
async function runRetentionOnce() {
    try {
        const cutoff = Date.now() - RET_D;
        let total = 0;
        const CAP = 25;
        const jobs = [
            ["deposits", "createdAt", "del"],
            ["orders", "createdAt", "refund:balance:amount"],
            ["redemptions", "createdAt", "del"],
            ["withdrawals", "createdAt", "refund:playPoints:points"],
            ["gateway_sms", "receivedAt", "del"],
            ["logs", "createdAt", "del"]
        ];
        for (const [col, tf, mode] of jobs) {
            try {
                const qs = await db.collection(col).where(tf, "<", new Date(cutoff)).limit(CAP).get();
                if (qs.empty) continue;
                for (const d of qs.docs) {
                    try {
                        const v = d.data() || {};
                        const ms = tsMs(v[tf]);
                        if (!ms || ms >= cutoff) continue;
                        const st = (v.status || "").toString();
                        if (st === "pending" || st === "paid") {
                            const fresh = await d.ref.get().catch(() => null);
                            if (!fresh || !fresh.exists) continue;
                            const fv = fresh.data() || {};
                            const fst = (fv.status || "").toString();
                            if (fst !== "pending" && fst !== "paid") continue;
                            if (mode.indexOf("refund:") === 0) {
                                const parts = mode.split(":");
                                if (await refundAndDelete(d, fv, parts[1], fv[parts[2]])) total++;
                            } else {
                                await d.ref.delete();
                                total++;
                            }
                        } else {
                            await d.ref.delete();
                            total++;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        try {
            const qs = await db.collection("pending_points").where("status", "==", "live").limit(CAP).get();
            if (!qs.empty) {
                for (const d of qs.docs) {
                    try {
                        const v = d.data() || {};
                        const ms = tsMs(v.unlockAt) || tsMs(v.movedAt) || tsMs(v.createdAt);
                        if (ms && ms < cutoff) { await d.ref.delete(); total++; }
                    } catch (e) {}
                }
            }
        } catch (e) {}
        if (total) console.log("[RETENTION] 10d+ purono " + total + " doc deleted");
    } catch (e) {}
}
setInterval(runRetentionOnce, 12 * 60 * 60 * 1000);
setTimeout(runRetentionOnce, 5 * 60 * 1000);

// ---------------- 3. CONFIGURATIONS ----------------
// ✅ আপনার দেওয়া নতুন Telegram Credentials
const DEFAULT_API_ID = 39447470;
const DEFAULT_API_HASH = "eb7cac1c8ad9935d4b208dc0da076d8c";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAGdST6cFQmE71kUkGX6NVnwImzUwA27wh4";
const ORDER_LOG_CHANNEL = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

// 409 Conflict প্রতিরোধে safe polling
const userNotifyBot = new TelegramBot(USER_NOTIFY_BOT_TOKEN, { polling: true });
userNotifyBot.on("polling_error", () => {});

const BOT_USERNAME = "Ppmod_bot";

// Cache image file_id to serve /start in <50ms without downloading from R2 every time
let cachedWelcomeBannerFileId = null;

// Leaderboard Memory Cache (TTL: 20 seconds for zero lag)
let cachedLeaderboardData = {
    list: [],
    updatedAt: 0
};

// Register Telegram Menu Commands on Startup
userNotifyBot.setMyCommands([
    { command: "start", description: "🚀 স্টার্ট করুন ও অফার দেখুন" },
    { command: "refer", description: "👥 রেফারেল ড্যাশবোর্ড ও লিংক" },
    { command: "leaderboard", description: "🏆 সেরা ১০ রেফারেল লিডারবোর্ড" },
    { command: "profile", description: "👤 আপনার একাউন্ট প্রোফাইল" }
]).catch(() => {});

const PRIME_AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791345238749_file_000000003d348211a5a894b5cf98d67c.png";
const PRIME_AUTO_REPLY_CAPTION = `👋 <b>হ্যালো!</b>\n\nএডমিন অনলাইনে আসলে আপনার মেসেজের রিপ্লাই দেওয়া হবে। আপনার কী প্রয়োজন তা নিচে লিখে রাখুন।\n\n⚡ <b>Auto Quest Complete মাত্র ৩ সেকেন্ডে:</b>\n👉 <a href="https://ppmods.netlify.app/">https://ppmods.netlify.app/</a>\n\n📢 <b>আমাদের সকল চ্যানেল ও গ্রুপ (১-ক্লিক ফোল্ডার):</b>\n👉 <a href="https://t.me/addlist/BmHpnIKMpzQzN2Fl">https://t.me/addlist/BmHpnIKMpzQzN2Fl</a>\n\nধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
// Multi-Prime pool: phone -> { client, connectedAt }
const primeClients = new Map();
let primeClient = null; // compat: first connected prime
let primePhone = null;

const activeOrders = new Set();
const completedOrdersTracker = new Set();
const processedTrxSet = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map();

function isBotTaskCompleted(rawText) {
    if (!rawText) return false;
    const t = rawText.toLowerCase();
    if (t.includes("error") || t.includes("failed") || t.includes("rejected") || 
        t.includes("cancel") || t.includes("tap") || t.includes("notification to your phone") ||
        t.includes("send format") || t.includes("confirm credentials")) {
        return false;
    }
    return (
        t.includes("all quests") ||
        t.includes("completed") ||
        t.includes("complete") ||
        t.includes("claim your points") ||
        t.includes("claim points") ||
        t.includes("quest finished") ||
        t.includes("task finished") ||
        t.includes("quests finished") ||
        t.includes("successfully") ||
        t.includes("done!") ||
        /\b(?:done|finished)\b/i.test(t)
    );
}

// --- SMART WORKER LOAD BALANCER & QUEUE ENGINE ---
const busyWorkers = new Set(); // কোন কোন টেলিগ্রাম অ্যাকাউন্ট এখন কাজে ব্যস্ত
let isQueueProcessing = false;

// সঠিক BD Phone Formatter
function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+880" + num.substring(1);
    if (num.startsWith("1") && num.length === 10) return "+880" + num;
    return "+" + num;
}

// ---------------- 3b. USER BOT REFERRAL SYSTEM ----------------
const FOLDER_INVITE_LINK = "https://t.me/addlist/BmHpnIKMpzQzN2Fl";
const WELCOME_BANNER_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1793161477971_file_000000003be882468416131a626117c0.png";

const REQUIRED_CHANNELS = [
    { name: "📢 Main Channel", url: "https://t.me/googleplaypointhack", username: "@googleplaypointhack" },
    { name: "📋 All Order Log", url: "https://t.me/ppmododderlog", username: "@ppmododderlog" },
    { name: "💬 Community Group", url: "https://t.me/GPPHMCOMMUNITY", username: "@GPPHMCOMMUNITY" }
];

function generateReferralCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let randomPart = "";
    for (let i = 0; i < 6; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `PPM-REF-${randomPart}`;
}

// ---------------- ANTI-FAKE REFERRAL COUNTRY FILTER & WHITELIST ----------------
const adminWhitelistedPhones = new Set();

async function checkAllowedCountry(rawPhone) {
    if (!rawPhone) return { allowed: false, phone: "" };
    const clean = rawPhone.toString().replace(/[^0-9]/g, "");

    // ১. শুধুমাত্র বাংলাদেশ (+880) স্বয়ংক্রিয়ভাবে অনুমোদিত
    if (clean.startsWith("880")) {
        return { allowed: true, country: "বাংলাদেশ (+880)", phone: clean, isProbashi: false };
    }

    // ২. অ্যাডমিন অনুমোদিত প্রবাসী নম্বর চেক (Memory & Firestore)
    if (adminWhitelistedPhones.has(clean)) {
        return { allowed: true, country: "অনুমোদিত প্রবাসী (Whitelisted)", phone: clean, isProbashi: true };
    }

    try {
        const snap = await db.collection("allowed_phones").doc(clean).get();
        if (snap.exists) {
            adminWhitelistedPhones.add(clean);
            return { allowed: true, country: "অনুমোদিত প্রবাসী (Whitelisted)", phone: clean, isProbashi: true };
        }
    } catch (e) {}

    return { allowed: false, phone: clean, isProbashi: false };
}

// ---------------- 5-CHARACTER ALPHANUMERIC ANTI-BOT CAPTCHA ----------------
const pendingCaptchas = new Map(); // userId -> { code, expires }

function generateAlphanumericCaptcha() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function sendRandomCaptcha(chatId, userId, editMessageId = null) {
    const code = generateAlphanumericCaptcha();
    pendingCaptchas.set(userId, {
        code: code,
        expires: Date.now() + 300000 // 5 minutes validity
    });

    const spacedArt = code.split("").join("  •  ");
    const text = 
        `🤖 <b>হিউম্যান সিকিউরিটি ভেরিফিকেশন (CAPTCHA)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `রোবট ও ফেক স্ক্রিপ্ট প্রতিরোধে নিচের বক্সের <b>৫ অক্ষরের কোডটি</b> দেখে চ্যাটে লিখে পাঠান:\n\n` +
        `<code>╔══════════════════════╗</code>\n` +
        `<code>║   🎯   ${spacedArt}   ║</code>\n` +
        `<code>╚══════════════════════╝</code>\n\n` +
        `👉 <b>আপনার করণীয়:</b> উপরের কোডটি দেখে হুবহু লিখে এই মেসেজের রিপ্লাই দিন বা চ্যাটে পাঠিয়ে দিন।\n\n` +
        `⚠️ <b>সতর্কতা:</b> ভুল কোড লিখলে অ্যাকাউন্ট সাথে সাথে <b>১২ ঘণ্টার জন্য লক</b> হয়ে যাবে!`;

    if (editMessageId) {
        try {
            return await userNotifyBot.editMessageText(text, {
                chat_id: chatId,
                message_id: editMessageId,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[{ text: "🔄 নতুন কোড দিন (New Code)", callback_data: "start_captcha" }]]
                }
            });
        } catch (e) {}
    }

    return await userNotifyBot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: "🔄 নতুন কোড দিন (New Code)", callback_data: "start_captcha" }]]
        }
    });
}

async function checkUserMembership(userId) {
    try {
        const uid = parseInt(userId, 10);
        if (!uid || isNaN(uid)) return true;

        const checks = REQUIRED_CHANNELS.map(async (ch) => {
            const uname = (ch.username || "").trim();
            if (!uname) return true;
            try {
                const member = await userNotifyBot.getChatMember(uname, uid);
                if (member && ["creator", "administrator", "member", "restricted"].includes(member.status)) {
                    return true;
                }
                if (member && (member.status === "left" || member.status === "kicked")) {
                    return false;
                }
                return true;
            } catch (e) {
                const msg = ((e && e.message) || "").toLowerCase();
                if (msg.includes("user_not_participant") || msg.includes("not a member") || msg.includes("user not found")) {
                    return false;
                }
                // বটের নিজস্ব পারমিশন বা চ্যানেল রেস্ট্রিকশনে ইউজারকে মিথ্যাভাবে ব্লক না করা
                return true;
            }
        });
        const results = await Promise.all(checks);
        return results.every(Boolean);
    } catch (e) {
        return true;
    }
}

async function enforceChannelMembership(chatId, userId) {
    const isMember = await checkUserMembership(userId);
    if (!isMember) {
        await userNotifyBot.sendMessage(chatId,
            `❌ <b>আপনি আমাদের চ্যানেল বা গ্রুপে জয়েন নেই!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `বট ব্যবহার করতে এবং রেফারেল বা অফার অ্যাক্সেস করতে আপনাকে অবশ্যই নিচের সব চ্যানেল ও গ্রুপে জয়েন থাকতে হবে:\n\n` +
            `├ 📢 <a href="https://t.me/googleplaypointhack">Main Channel</a>\n` +
            `├ 📋 <a href="https://t.me/ppmododderlog">All Order Log</a>\n` +
            `└ 💬 <a href="https://t.me/GPPHMCOMMUNITY">Community Group</a>\n\n` +
            `👉 ১-ক্লিকে সব জয়েন করতে নিচের বাটনে চাপ দিন:`,
            {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Join All Channels (1-Click Folder)", url: FOLDER_INVITE_LINK }],
                        [{ text: "🔄 জয়েন করেছি, চেক করুন", callback_data: "recheck_channels" }]
                    ]
                }
            }
        ).catch(() => {});
        return false;
    }
    return true;
}

function getMainMenuReplyKeyboard(isVerified = false) {
    return {
        keyboard: [
            [{ text: "🚀 Auto Quest (3s)" }, { text: "👤 Profile" }],
            [{ text: "👥 Referral" }, { text: "🏆 Leaderboard" }],
            [
                { text: isVerified ? "🌐 Visit Website" : "🔐 Verify Account" },
                { text: "💬 Support" }
            ]
        ],
        resize_keyboard: true,
        persistent: true
    };
}

function getJoinKeyboard(userId, refId = null, isVerified = false) {
    const verifyData = refId ? `verify_ref:${refId}` : "verify_ref:none";
    if (isVerified) {
        return {
            inline_keyboard: [
                [{ text: "🚀 Auto Quest (Website)", url: "https://ppmods.netlify.app/" }],
                [{ text: "👥 Referral Dashboard", callback_data: "my_ref_info" }, { text: "🏆 Leaderboard", callback_data: "show_leaderboard" }],
                [{ text: "📢 Main Community", url: "https://t.me/googleplaypointhack" }]
            ]
        };
    }
    return {
        inline_keyboard: [
            [{ text: "🚀 Join All Channels (1-Click Folder)", url: FOLDER_INVITE_LINK }],
            [{ text: "🔐 Verify Account / একাউন্ট ভেরিফাই", callback_data: verifyData }],
            [
                { text: "🏆 Top 10 Leaderboard", callback_data: "show_leaderboard" },
                { text: "👥 Referral Stats", callback_data: "my_ref_info" }
            ]
        ]
    };
}

// ---------------- ADMIN SWIPE-TO-REPLY & COMMAND HANDLERS ----------------
// Helper: User Dashboard Card Formatter
function buildUserAdminCard(uid, uData) {
    const cleanBal = Math.round(((Number(uData.balance) || 0) + Number.EPSILON) * 100) / 100;
    const cleanPoints = Number(uData.playPoints) || 0;
    const isBanned = (uData.banned === true || uData.banned === 1 || uData.banned === "1");
    const joinDate = uData.createdAt && uData.createdAt.toDate ? uData.createdAt.toDate().toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }) : "—";

    const curStars = Number(uData.loyaltyStars || 0);
    const realBal = Number(uData.realBalance !== undefined ? uData.realBalance : (uData.balance || 0));
    const bonusBal = Number(uData.bonusBalance || 0);
    const cleanName = (uData.name || "User").replace(/[<>&]/g, "").trim().slice(0, 30);
    const cleanEmail = (uData.email || "No Email").replace(/[<>&]/g, "").trim();

    const text = 
        `👤 <b>USER PROFILE MANAGEMENT</b>\n\n` +
        `📛 <b>Name:</b> ${cleanName}\n` +
        `📧 <b>Email:</b> <code>${cleanEmail}</code>\n` +
        `🆔 <b>UID:</b> <code>${uid}</code>\n\n` +
        `💰 <b>Real (Deposit):</b> <code>${realBal} Coins</code>\n` +
        `🎁 <b>Bonus (Other):</b> <code>${bonusBal} Coins</code>\n` +
        `🪙 <b>Total Coins:</b> <b>${cleanBal} Coins</b>\n\n` +
        `৳ <b>Taka Wallet:</b> <b>৳ ${cleanPoints}</b>\n` +
        `🎖️ <b>Loyalty Stars:</b> <b>${curStars} / 10 Stars</b> <i>(Real-এ বাড়ে)</i>\n` +
        `✈️ <b>Telegram:</b> ${uData.tgChatId || "Not Connected"}\n` +
        `📅 <b>Joined:</b> ${joinDate}\n` +
        `📌 <b>Status:</b> ${isBanned ? "🚫 <b>BANNED</b>" : "✅ <b>ACTIVE</b>"}`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: isBanned ? "✅ Unban User" : "🚫 Ban User", callback_data: `u_toggle_ban:${uid}` },
                { text: "🔄 Refresh", callback_data: `u_refresh:${uid}` }
            ],
            [
                { text: "➕ Add Real", callback_data: `u_ask_add_real:${uid}` },
                { text: "➖ Deduct Real", callback_data: `u_ask_sub_real:${uid}` }
            ],
            [
                { text: "➕ Add Bonus", callback_data: `u_ask_add_bonus:${uid}` },
                { text: "➖ Deduct Bonus", callback_data: `u_ask_sub_bonus:${uid}` }
            ],
            [
                { text: "⭐ +1 Star", callback_data: `u_mod_star:${uid}:1` },
                { text: "⭐ -1 Star", callback_data: `u_mod_star:${uid}:-1` }
            ]
        ]
    };

    return { text, reply_markup: keyboard };
}

userNotifyBot.on("message", async (msg) => {
    try {
        const text = (msg.text || "").trim();
        const chatId = msg.chat.id;
        const fromId = msg.from ? msg.from.id.toString() : chatId.toString();

        // স্থায়ী মেনু বাটন হ্যান্ডলার (Quest Bot এর মতো)
        if (text === "🚀 Auto Quest (3s)" || text === "🌐 Visit Website") {
            return userNotifyBot.sendMessage(chatId,
                `⚡ <b>PP MOD AUTO QUEST ENGINE</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `মাত্র ৩ সেকেন্ডে গুগল প্লে পয়েন্ট কোয়েস্ট টাস্ক সম্পন্ন করতে নিচের লিংকে যান:\n\n` +
                `👉 <a href="https://ppmods.netlify.app/">https://ppmods.netlify.app/</a>\n\n` +
                `📢 <b>অফিশিয়াল চ্যানেল:</b> @googleplaypointhack`,
                { parse_mode: "HTML", disable_web_page_preview: false }
            );
        }
        if (text === "👤 Profile") {
            const isJoined = await enforceChannelMembership(chatId, fromId);
            if (!isJoined) return;
            return userNotifyBot.sendMessage(chatId,
                `👤 <b>আপনার একাউন্ট প্রোফাইল</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🆔 <b>Telegram ID:</b> <code>${fromId}</code>\n` +
                `📛 <b>Name:</b> ${safeTgHtml(msg.from.first_name || "User")}\n` +
                `✈️ <b>Username:</b> ${msg.from.username ? '@' + msg.from.username : 'None'}\n\n` +
                `🚀 <b>Web App:</b> <a href="https://ppmods.netlify.app/">https://ppmods.netlify.app/</a>`,
                { parse_mode: "HTML" }
            );
        }
        if (text === "👥 Referral") {
            const isJoined = await enforceChannelMembership(chatId, fromId);
            if (!isJoined) return;
            const userName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
            const userUsername = msg.from.username ? `@${msg.from.username}` : "";
            return sendReferralDashboard(chatId, fromId, userName, userUsername, null);
        }
        if (text === "🏆 Leaderboard") {
            const isJoined = await enforceChannelMembership(chatId, fromId);
            if (!isJoined) return;
            return sendLeaderboard(chatId, fromId, null);
        }
        if (text === "🔐 Verify Account") {
            const isJoined = await checkUserMembership(fromId);
            if (!isJoined) {
                return enforceChannelMembership(chatId, fromId);
            }
            const userRef = db.collection("tg_bot_users").doc(fromId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};
            if (userData.isVerified) {
                return userNotifyBot.sendMessage(chatId, "✅ <b>আপনার অ্যাকাউন্ট ইতিমধ্যে সম্পূর্ণ ভেরিফাইড!</b>", {
                    parse_mode: "HTML",
                    reply_markup: getMainMenuReplyKeyboard(true)
                });
            }
            if (userData.phone) {
                return sendRandomCaptcha(chatId, fromId, null);
            }
            return userNotifyBot.sendMessage(chatId,
                `🛡️ <b>অ্যাকাউন্ট ভেরিফিকেশন (ধাপ ১ / ২)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `নিচের <b>"📱 Share Contact / ফোন নম্বর ভেরিফাই"</b> বাটনে চাপ দিন:\n\n` +
                `✅ <b>অনুমোদিত দেশ:</b> বাংলাদেশ (+880), ভারত (+91), পাকিস্তান (+92), সৌদি আরব (+966), দুবাই (+971)।`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        keyboard: [[{ text: "📱 Share Contact / ফোন নম্বর ভেরিফাই", request_contact: true }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
        }
        if (text === "💬 Support") {
            return userNotifyBot.sendMessage(chatId,
                `💬 <b>PP MOD এডমিন সাপোর্ট</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `যেকোনো সমস্যা, ডিপোজিট বা ভেরিফিকেশনে সরাসরি যোগাযোগ করুন:\n` +
                `👉 <a href="https://t.me/Blackmoney54">@Blackmoney54</a>`,
                { parse_mode: "HTML" }
            );
        }

        // Skip only commands with separate dedicated onText handlers
        if (/^\/(?:start|profile|leaderboard|top|lb|referr|refer|referral|ref|panel544)(?:@\w+)?/i.test(text)) return;
        const replyTo = msg.reply_to_message;

        const isFromAdmin = isBotAdmin(msg.chat.id) || (msg.from && isBotAdmin(msg.from.id));

        // ---------------- 1. PHONE CONTACT VERIFICATION (STEP 1) ----------------
        if (msg.contact) {
            const contact = msg.contact;
            const fromId = msg.from ? msg.from.id.toString() : "";
            const contactUserId = contact.user_id ? contact.user_id.toString() : "";

            // Anti-Spoofing: Must be user's own contact card
            if (contactUserId && contactUserId !== fromId) {
                return userNotifyBot.sendMessage(chatId,
                    `❌ <b>ভেরিফিকেশন ব্যর্থ!</b>\n\nঅন্য কারো বা ফরোয়ার্ড করা কন্টাক্ট গ্রহণযোগ্য নয়। নিচে দেওয়া বাটনে চাপ দিয়ে আপনার নিজস্ব টেলিগ্রাম অ্যাকাউন্টের ফোন নম্বর শেয়ার করুন।`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            keyboard: [[{ text: "📱 Share Contact / ফোন নম্বর ভেরিফাই", request_contact: true }]],
                            resize_keyboard: true,
                            one_time_keyboard: true
                        }
                    }
                );
            }

            // Channel Membership Check
            const isJoined = await checkUserMembership(fromId);
            if (!isJoined) {
                return enforceChannelMembership(chatId, fromId);
            }

            // Country Whitelist Check: Only Bangladesh (+880) or Admin Whitelisted Probashi
            const countryCheck = await checkAllowedCountry(contact.phone_number);
            if (!countryCheck.allowed) {
                return userNotifyBot.sendMessage(chatId,
                    `❌ <b>অননুমোদিত দেশ / Unsupported Country!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🇧🇩 <b>বাংলা:</b>\n` +
                    `আপনার ফোন নম্বরটি (<code>+${countryCheck.phone}</code>) অনুমোদিত দেশের তালিকায় নেই।\n` +
                    `শুধুমাত্র <b>বাংলাদেশি নম্বর (+880)</b> সরাসরি অনুমোদিত। আপনি যদি <b>প্রবাসী বাংলাদেশি</b> হয়ে থাকেন, তবে আপনার নম্বরটি অনুমোদন করতে সরাসরি অ্যাডমিনের সাথে যোগাযোগ করুন।\n\n` +
                    `🇬🇧 <b>English:</b>\n` +
                    `Your phone number (<code>+${countryCheck.phone}</code>) is from an unsupported country.\n` +
                    `Only Bangladeshi numbers (+880) are automated. If you are an expatriate Bangladeshi, please contact Admin to whitelist your number.\n━━━━━━━━━━━━━━━━━━━━━━`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "💬 Contact Admin / এডমিন সাপোর্ট", url: "https://t.me/Blackmoney54" }]
                            ]
                        }
                    }
                );
            }

            // Duplicate phone check: 1 phone = 1 Telegram account
            const cleanPhone = countryCheck.phone;
            try {
                const phoneSnap = await db.collection("tg_bot_users").where("phone", "==", cleanPhone).get();
                if (!phoneSnap.empty) {
                    const existing = phoneSnap.docs.find(d => d.id !== fromId);
                    if (existing) {
                        return userNotifyBot.sendMessage(chatId,
                            `❌ <b>এই নম্বরটি ইতিমধ্যে ব্যবহৃত!</b>\n\n` +
                            `ফোন নম্বর <code>+${cleanPhone}</code> দিয়ে ইতিমধ্যে অন্য একটি টেলিগ্রাম অ্যাকাউন্ট ভেরিফাই করা হয়েছে।\n` +
                            `১টি ফোন নম্বর দিয়ে কেবল ১টি টেলিগ্রাম অ্যাকাউন্টই ভেরিফাই করা সম্ভব।`,
                            { parse_mode: "HTML", reply_markup: { remove_keyboard: true } }
                        );
                    }
                }
            } catch (e) {}

            // Save phone and advance stage to awaiting_captcha
            await db.collection("tg_bot_users").doc(fromId).set({
                id: fromId,
                phone: cleanPhone,
                phoneCountry: countryCheck.country,
                verificationStage: "awaiting_captcha",
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            return userNotifyBot.sendMessage(chatId,
                `✅ <b>ধাপ ১ সম্পন্ন! ফোন নম্বর যাচাইকৃত (${countryCheck.country})</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🧩 <b>ধাপ ২: রোবট/ক্যাপচা যাচাই (Verify Step 2):</b>\n\n` +
                `আপনি কোনো অটোমেটেড বট বা স্ক্রিপ্ট নন তা নিশ্চিত করতে নিচের <b>"Verify Step 2 (ক্যাপচা)"</b> বাটনে চাপ দিন।\n\n` +
                `⚠️ <b>সতর্কতা:</b> ক্যাপচায় ভুল উত্তর দিলে আপনার ভেরিফিকেশন <b>১২ ঘণ্টার জন্য লক</b> হয়ে যাবে!`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🧩 Verify Step 2 (ক্যাপচা শুরু করুন)", callback_data: "start_captcha" }]
                        ]
                    }
                }
            );
        }

        // ---------------- 2. USER TEXT CAPTCHA SUBMISSION ----------------
        if (pendingCaptchas.has(fromId) && !text.startsWith("/")) {
            const pending = pendingCaptchas.get(fromId);
            const userRef = db.collection("tg_bot_users").doc(fromId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

            if (Date.now() > pending.expires) {
                pendingCaptchas.delete(fromId);
                return userNotifyBot.sendMessage(chatId, "⌛ <b>ক্যাপচার ৫ মিনিট সময় শেষ!</b>\nনিচের বাটনে চাপ দিয়ে নতুন কোড নিন:", {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [[{ text: "🔄 নতুন ক্যাপচা নিন", callback_data: "start_captcha" }]]
                    }
                });
            }

            const cleanInput = text.toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
            const correctCode = pending.code.toUpperCase().trim();

            // ৫ অক্ষরের কম বা বেশি দিলে ওয়ার্নিং দেবে, সাথে সাথে লক করবে না
            if (cleanInput.length !== 5) {
                return userNotifyBot.sendMessage(chatId,
                    `⚠️ <b>কোডটি ঠিক ৫ অক্ষরের হতে হবে!</b>\n` +
                    `বক্সে দেখানো ৫ অক্ষরের কোডটি দেখে সঠিকভাবে লিখে পাঠান।`,
                    { parse_mode: "HTML" }
                );
            }

            if (cleanInput === correctCode) {
                // ✅ ক্যাপচা সফল! সম্পূর্ণ ভেরিফাইড
                pendingCaptchas.delete(fromId);

                await userRef.set({
                    id: fromId,
                    isVerified: true,
                    verificationStage: "completed",
                    captchaLockedUntil: null,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                const uName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "User";
                const uUsername = msg.from.username ? `@${msg.from.username}` : "";

                cfFetch(`${CF_API}/api/bot/user/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: fromId,
                        name: uName,
                        username: uUsername,
                        phone: userData.phone || "",
                        isVerified: 1
                    })
                }).catch(() => {});

                // রেফারারকে বোনাস প্রদান (+০.৫ Coins ও +১ রেফারেল)
                const targetInviterId = userData.inviterId;
                if (targetInviterId && targetInviterId !== fromId) {
                    const bonusToAdd = (publicCache && publicCache.config && publicCache.config.tgRefBonus !== undefined)
                        ? Number(publicCache.config.tgRefBonus)
                        : 0.5;

                    cfFetch(`${CF_API}/api/bot/user/update`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: targetInviterId,
                            addRefCount: 1,
                            addRefBalance: bonusToAdd
                        })
                    }).catch(() => {});

                    db.collection("tg_bot_users").doc(targetInviterId).set({
                        id: targetInviterId,
                        referralCount: admin.firestore.FieldValue.increment(1),
                        refBalance: admin.firestore.FieldValue.increment(bonusToAdd)
                    }, { merge: true }).catch(() => {});

                    userNotifyBot.sendMessage(targetInviterId,
                        `🎉 <b>নতুন সম্পূর্ণ ভেরিফাইড রেফার!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 ইউজার: <b>${safeTgHtml(uName)}</b>\n` +
                        `🪙 <b>+${bonusToAdd} PP Coins</b> রেফার ব্যালেন্সে যুক্ত হয়েছে!`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});
                }

                userNotifyBot.sendMessage(chatId, "✅ <b>আপনার অ্যাকাউন্ট সফলভাবে সম্পূর্ণ ভেরিফাইড হয়েছে!</b>", {
                    parse_mode: "HTML",
                    reply_markup: getMainMenuReplyKeyboard(true)
                }).catch(() => {});

                return userNotifyBot.sendMessage(chatId,
                    `🎉 <b>অভিনন্দন! ক্যাপচা সফল হয়েছে!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 ফোন নম্বর: <b>+${userData.phone || "Verified"}</b>\n` +
                    `🧩 ক্যাপচা: <b>উত্তীর্ণ (রিয়েল হিউম্যান)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `এখন থেকে আপনি সম্পূর্ণ নিরাপদভাবে বন্ধুদের রেফার করে কয়েন ইনকাম করতে পারবেন।`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "👥 আমার রেফারেল ড্যাশবোর্ড", callback_data: "my_ref_info" }],
                                [{ text: "🏆 লিডারবোর্ড দেখুন", callback_data: "show_leaderboard" }]
                            ]
                        }
                    }
                );
            } else {
                // ❌ ভুল কোড ইনপুট -> ১২ ঘণ্টার লকআউট
                pendingCaptchas.delete(fromId);
                const lockedUntil = Date.now() + (12 * 60 * 60 * 1000);

                await userRef.set({ captchaLockedUntil: lockedUntil }, { merge: true }).catch(() => {});

                return userNotifyBot.sendMessage(chatId,
                    `❌ <b>ভুল কোড! ভেরিফিকেশন ১২ ঘণ্টার জন্য লক!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `আপনি সঠিক কোড দেননি। স্ক্রিপ্ট ও ফেক রেফারেল রোধে আপনার ভেরিফিকেশন <b>১২ ঘণ্টার জন্য লক</b> করা হয়েছে।\n\n` +
                    `⏳ ১২ ঘণ্টা পর আপনি পুনরায় সুযোগ পাবেন।`,
                    { parse_mode: "HTML" }
                );
            }
        }

        // ---------------- 3. ADMIN WHITELIST PROBASHI PHONES ----------------
        if (text.startsWith("/allowphone ") && isFromAdmin) {
            const raw = text.replace("/allowphone ", "").trim();
            const clean = raw.replace(/[^0-9]/g, "");
            if (!clean || clean.length < 7) {
                return userNotifyBot.sendMessage(chatId, "💡 ব্যবহার: <code>/allowphone 966501234567</code> (দেশীয় কোডসহ নম্বর)", { parse_mode: "HTML" });
            }
            adminWhitelistedPhones.add(clean);
            await db.collection("allowed_phones").doc(clean).set({
                phone: clean,
                addedBy: fromId,
                addedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            return userNotifyBot.sendMessage(chatId, `✅ <b>প্রবাসী নম্বর অনুমোদন সফল!</b>\n📱 <code>+${clean}</code> নম্বরটি সফলভাবে অ্যালাউ করা হয়েছে। এখন এই নম্বর দিয়ে ভেরিফাই করা যাবে।`, { parse_mode: "HTML" });
        }

        if (text.startsWith("/delphone ") && isFromAdmin) {
            const raw = text.replace("/delphone ", "").trim();
            const clean = raw.replace(/[^0-9]/g, "");
            adminWhitelistedPhones.delete(clean);
            await db.collection("allowed_phones").doc(clean).delete().catch(() => {});
            return userNotifyBot.sendMessage(chatId, `🗑️ <code>+${clean}</code> নম্বরটি অনুমোদন তালিকা থেকে মুছে দেওয়া হয়েছে।`, { parse_mode: "HTML" });
        }

        // ---------------- 4. ADMIN SINGLE USER REFERRAL RESET & SET ----------------
        if (text.startsWith("/resetref ") && isFromAdmin) {
            const targetId = text.replace("/resetref ", "").trim();
            if (!targetId) return userNotifyBot.sendMessage(chatId, "💡 ব্যবহার: <code>/resetref Telegram_User_ID</code>", { parse_mode: "HTML" });

            await cfFetch(`${CF_API}/api/bot/user/update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: targetId, resetRefBalance: 1 })
            }).catch(() => {});

            await db.collection("tg_bot_users").doc(targetId).set({
                referralCount: 0,
                refBalance: 0
            }, { merge: true }).catch(() => {});

            cachedLeaderboardData = { list: [], updatedAt: 0 };
            return userNotifyBot.sendMessage(chatId, `✅ <b>ইউজার [<code>${targetId}</code>] এর রেফারেল রিসেট সম্পন্ন!</b>\nরেফার: <b>০ জন</b> | ব্যালেন্স: <b>০ Coins</b>`, { parse_mode: "HTML" });
        }

        if (text.startsWith("/setref ") && isFromAdmin) {
            const parts = text.split(/\s+/).filter(Boolean);
            const targetId = parts[1];
            const newCount = parseInt(parts[2], 10);
            const newBal = parseFloat(parts[3]);
            if (!targetId || isNaN(newCount) || isNaN(newBal)) {
                return userNotifyBot.sendMessage(chatId, "💡 ব্যবহার: <code>/setref User_ID 5 2.5</code> (ID, Count, Balance)", { parse_mode: "HTML" });
            }

            await cfFetch(`${CF_API}/api/bot/user/update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: targetId, referralCount: newCount, refBalance: newBal, resetRefBalance: 1 })
            }).catch(() => {});

            await db.collection("tg_bot_users").doc(targetId).set({
                referralCount: newCount,
                refBalance: newBal
            }, { merge: true }).catch(() => {});

            cachedLeaderboardData = { list: [], updatedAt: 0 };
            return userNotifyBot.sendMessage(chatId, `✅ <b>ইউজার [<code>${targetId}</code>] এর রেফার আপডেট সম্পন্ন!</b>\nরেফার: <b>${newCount} জন</b> | ব্যালেন্স: <b>${newBal} Coins</b>`, { parse_mode: "HTML" });
        }

        // ---------------- 5. RESET ALL REFERRALS (CHUNKED SAFE BATCHES) ----------------
        if (text === "/resetallref" && isFromAdmin) {
            await userNotifyBot.sendMessage(chatId, "⏳ <b>সকল রেফারেল রিসেট করা হচ্ছে (D1 + Firestore)...</b>", { parse_mode: "HTML" });

            try {
                await cfFetch(`${CF_API}/api/bot/reset-all-referrals`, { method: "POST" });
            } catch (e) {
                console.warn("CF reset err:", e);
            }

            let count = 0;
            try {
                const snap = await db.collection("tg_bot_users").get();
                const docs = snap.docs;
                const CHUNK_SIZE = 400;

                for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
                    const chunk = docs.slice(i, i + CHUNK_SIZE);
                    const batch = db.batch();
                    chunk.forEach(docSnap => {
                        count++;
                        batch.update(docSnap.ref, {
                            referralCount: 0,
                            refBalance: 0,
                            isVerified: false,
                            verificationStage: "not_verified",
                            captchaLockedUntil: null
                        });
                    });
                    await batch.commit();
                }
            } catch (e) {
                console.warn("Firestore chunked reset err:", e);
            }

            cachedLeaderboardData = { list: [], updatedAt: 0 };

            return userNotifyBot.sendMessage(chatId,
                `✅ <b>সফলভাবে সকল রেফারেল শূন্য (০) করা হয়েছে!</b>\n\n` +
                `📊 মোট রিসেট: <b>${count}</b> জন\n` +
                `🪙 সবার রেফার ব্যালেন্স: <b>০ Coins</b>\n` +
                `👥 সবার রেফার কাউন্ট: <b>০</b>\n\n` +
                `পূর্বের ফেক রেফার মুছে দেওয়া হয়েছে। এখন থেকে নতুন ও আসল রেফারেল গণনা হবে।`,
                { parse_mode: "HTML" }
            );
        }

        // অ্যাডমিন কাস্টম কয়েন যোগ/কাটার রিপ্লাই দিলে তা Cloudflare D1 ও ফায়ারস্টোর দিয়ে সাথে সাথে হ্যান্ডেল করা
        if (replyTo && replyTo.text && isFromAdmin) {
            const repText = replyTo.text;
            const uidMatch = repText.match(/UID:\s*([A-Za-z0-9_-]+)/i);

            if (uidMatch) {
                const targetUid = uidMatch[1].trim();
                const rawVal = parseFloat(text);

                if (!isNaN(rawVal) && rawVal !== 0) {
                    const isAdd = repText.includes("যোগ করতে চান") || repText.includes("Add") || repText.includes("➕");
                    const isSub = repText.includes("কাটতে চান") || repText.includes("Deduct") || repText.includes("➖") || rawVal < 0;

                    if (isAdd || isSub) {
                        const absVal = Math.abs(rawVal);
                        const changeAmt = isSub ? -absVal : absVal;
                        const isTargetReal = repText.includes("[REAL]") || repText.includes("REAL") || repText.includes("রিয়েল");
                        const coinType = isTargetReal ? "real" : "bonus";

                        // ১. ফায়ারস্টোর থেকে বর্তমান ইউজার ব্যালেন্স আনা
                        let curReal = 0, curBonus = 0, newTotal = 0;
                        try {
                            const uDoc = await db.collection("users").doc(targetUid).get();
                            const uData = (uDoc.exists ? uDoc.data() : {}) || {};
                            curReal = Number(uData.realBalance !== undefined ? uData.realBalance : (uData.balance || 0));
                            curBonus = Number(uData.bonusBalance || 0);

                            if (coinType === "real") {
                                curReal = Math.max(0, Math.round((curReal + changeAmt + Number.EPSILON) * 100) / 100);
                            } else {
                                curBonus = Math.max(0, Math.round((curBonus + changeAmt + Number.EPSILON) * 100) / 100);
                            }
                            newTotal = Math.round((curReal + curBonus + Number.EPSILON) * 100) / 100;

                            await db.collection("users").doc(targetUid).set({
                                realBalance: curReal,
                                bonusBalance: curBonus,
                                balance: newTotal,
                                uid: targetUid
                            }, { merge: true });
                        } catch (fsErr) {
                            console.warn("Firestore update warn:", fsErr);
                        }

                        // ২. Cloudflare D1-এ ব্যালেন্স আপডেট ও সিঙ্ক (মাইনাস ব্যালেন্স কাটার জন্য set-balance নিশ্চিত করা)
                        try {
                            if (changeAmt < 0) {
                                const cfRes = await cfFetch(`${CF_API}/api/wallet/set-balance`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ uid: targetUid, balance: newTotal, realBalance: curReal, bonusBalance: curBonus })
                                });
                                const cfData = await cfRes.json();
                                if (cfData && cfData.ok) {
                                    newTotal = cfData.balance;
                                    curReal = cfData.realBalance;
                                    curBonus = cfData.bonusBalance;
                                }
                            } else {
                                const cfRes = await cfFetch(`${CF_API}/api/wallet/credit`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ uid: targetUid, coins: changeAmt, type: coinType })
                                });
                                const cfData = await cfRes.json();
                                if (cfData && cfData.ok) {
                                    newTotal = cfData.balance;
                                    curReal = cfData.realBalance;
                                    curBonus = cfData.bonusBalance;
                                }
                            }
                        } catch (e) {}

                        // ৩. সাথে সাথে ফ্রেশ ইউজার কার্ড তৈরি করে পাঠানো
                        const userFreshRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(targetUid)}`);
                        const userFreshData = await userFreshRes.json().catch(() => null);
                        const uObj = (userFreshData && userFreshData.user) ? userFreshData.user : { uid: targetUid, balance: newTotal, realBalance: curReal, bonusBalance: curBonus };
                        const card = buildUserAdminCard(targetUid, uObj);

                        await userNotifyBot.sendMessage(chatId,
                            `✅ <b>ব্যালেন্স আপডেট সফল!</b> [${isTargetReal ? 'REAL' : 'BONUS'}] ব্যালেন্সে <b>${isSub ? '-' : '+'}${absVal} Coins</b> হয়েছে।\n💰 Real: <b>${curReal}</b> | 🎁 Bonus: <b>${curBonus}</b>\n🪙 বর্তমান মোট: <b>${newTotal} Coins</b>`,
                            { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                        );

                        return userNotifyBot.sendMessage(chatId, card.text, {
                            parse_mode: "HTML",
                            reply_markup: card.reply_markup
                        });
                    }
                }
            }

            // অ্যাডমিন কোনো অর্ডারের মেসেজে রিপ্লাই দিয়ে কাস্টম মেসেজ পাঠালে তা হ্যান্ডেল করা
            const ordMatch = repText.match(/Order ID:\s*([A-Za-z0-9_-]+)/i);
            if (ordMatch && (repText.includes("ইউজারকে মেসেজ পাঠান") || repText.includes("Send Message") || repText.includes("মেসেজ লিখুন"))) {
                const targetOrderId = ordMatch[1].trim();
                const customMsg = text;

                await db.collection("orders").doc(targetOrderId).update({
                    adminMsg: customMsg
                }).catch(() => {});

                await cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        orderId: targetOrderId,
                        adminMsg: customMsg
                    })
                }).catch(() => {});

                // ইউজারকে টেলিগ্রামেও বার্তা পাঠানো
                try {
                    const ordDoc = await db.collection("orders").doc(targetOrderId).get();
                    if (ordDoc.exists) {
                        const od = ordDoc.data();
                        if (od.userTgId || od.uid) {
                            const notifyId = await getUserTgId(od.uid, od.userTgId);
                            await notifyUserTelegram(notifyId, `💬 <b>এডমিন বার্তা:</b>\n\n${customMsg}`).catch(() => {});
                        }
                    }
                } catch (e) {}

                return userNotifyBot.sendMessage(chatId,
                    `✅ <b>মেসেজ পাঠানো হয়েছে!</b>\n🔖 <b>Order ID:</b> <code>${targetOrderId}</code>\n💬 <b>মেসেজ:</b> <i>"${customMsg}"</i>`,
                    { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                );
            }
        }

        // অ্যাডমিন কমান্ড: /complete <orderId> বা /refund <orderId>
        if (text.startsWith("/complete ") || text.startsWith("/refund ") || text.startsWith("/order ")) {
            const parts = text.split(/\s+/).filter(Boolean);
            const cmd = parts[0].toLowerCase();
            const orderId = parts[1] ? parts[1].trim() : "";

            if (!orderId) {
                return userNotifyBot.sendMessage(chatId, `💡 <b>সঠিক নিয়ম:</b>\n👉 <code>/complete ORD-1234</code>\n👉 <code>/refund ORD-1234</code>`, { parse_mode: "HTML" });
            }

            if (cmd === "/complete") {
                let ordData = null;
                const ordDoc = await db.collection("orders").doc(orderId).get();
                if (ordDoc.exists) ordData = ordDoc.data();
                if (!ordData) {
                    const cfRes = await cfFetch(`${CF_API}/api/orders/status?id=${orderId}`);
                    const cfJson = await cfRes.json();
                    if (cfJson && cfJson.ok && cfJson.order) ordData = cfJson.order;
                }
                if (!ordData) return userNotifyBot.sendMessage(chatId, `❌ <code>${orderId}</code> অর্ডারটি পাওয়া যায়নি!`, { parse_mode: "HTML" });

                await db.collection("orders").doc(orderId).update({
                    status: "completed",
                    adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false,
                    inQueue: false
                }).catch(() => {});

                await cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        orderId,
                        status: "completed",
                        adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                        inQueue: false
                    })
                }).catch(() => {});

                if (ordData.uid && ordData.uid !== "guest") {
                    await cfFetch(`${CF_API}/api/wallet/credit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ uid: ordData.uid, loyaltyStarsInc: 1 })
                    }).catch(() => {});
                    db.collection("users").doc(ordData.uid).update({
                        loyaltyStars: admin.firestore.FieldValue.increment(1)
                    }).catch(() => {});
                }

                if (ordData.userTgId || ordData.uid) {
                    const notifyId = await getUserTgId(ordData.uid, ordData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${ordData.game || "Task"}\n` +
                        `🪙 <b>ফি:</b> ${ordData.amount || 3} PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    ).catch(() => {});
                }

                return userNotifyBot.sendMessage(chatId, `✅ <b>অর্ডার সম্পন্ন করা হয়েছে!</b>\n🔖 <b>Order ID:</b> <code>${orderId}</code>`, { parse_mode: "HTML" });
            }

            if (cmd === "/refund") {
                let ordData = null;
                const ordDoc = await db.collection("orders").doc(orderId).get();
                if (ordDoc.exists) ordData = ordDoc.data();
                if (!ordData) {
                    const cfRes = await cfFetch(`${CF_API}/api/orders/status?id=${orderId}`);
                    const cfJson = await cfRes.json();
                    if (cfJson && cfJson.ok && cfJson.order) ordData = cfJson.order;
                }
                if (!ordData) return userNotifyBot.sendMessage(chatId, `❌ <code>${orderId}</code> অর্ডারটি পাওয়া যায়নি!`, { parse_mode: "HTML" });

                await refundOrder(orderId, ordData.uid, "❌ এডমিন দ্বারা টাস্কটি বাতিল ও কয়েন রিফান্ড করা হয়েছে।", ordData.userTgId);
                return userNotifyBot.sendMessage(chatId, `❌ <b>অর্ডার রিফান্ড ও বাতিল করা হয়েছে!</b>\n🔖 <b>Order ID:</b> <code>${orderId}</code>`, { parse_mode: "HTML" });
            }
        }

        // অ্যাডমিন টেলিগ্রাম বট থেকে সরাসরি প্রোমো কোড তৈরি (/create বা /code)
        if (text.startsWith("/create") || text.startsWith("/code")) {
            const parts = text.split(/\s+/).filter(Boolean);
            let codeName = "";
            let amount = 0;

            if (parts.length === 2) {
                // e.g. /create 50
                amount = parseFloat(parts[1]);
                codeName = "PPM-" + Math.random().toString(36).substring(2, 7).toUpperCase();
            } else if (parts.length >= 3) {
                // e.g. /create GIFT100 100
                codeName = parts[1].toUpperCase();
                amount = parseFloat(parts[2]);
            }

            if (!amount || isNaN(amount) || amount <= 0) {
                return userNotifyBot.sendMessage(chatId,
                    `💡 <b>রিডিম কোড তৈরির নিয়ম:</b>\n\n` +
                    `👉 <code>/create 50</code> (অটোমেটিক কোড জেনারেট হবে)\n` +
                    `👉 <code>/create PROMO50 50</code> (কাস্টম কোড তৈরি হবে)`,
                    { parse_mode: "HTML" }
                );
            }

            await db.collection("codes").doc(codeName).set({
                amount: amount,
                maxUses: 1,
                used: 0,
                active: true,
                note: "Generated via Admin Telegram",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            return userNotifyBot.sendMessage(chatId,
                `🎉 <b>REWARD CODE CREATED!</b>\n\n` +
                `🔖 <b>Code:</b> <code>${codeName}</code>\n` +
                `🪙 <b>Amount:</b> <b>${amount} PP Coins</b>\n` +
                `👥 <b>Max Uses:</b> 1 User\n\n` +
                `<i>ইউজার এই কোডটি অ্যাপের Rewards বক্সে দিলে সাথে সাথে ${amount} Coins পাবে!</i>`,
                { parse_mode: "HTML" }
            );
        }

        // /logon এবং /logoff কমান্ড
        if (text === "/logoff") {
            isAutoFakeLogEnabled = false;
            await db.collection("config").doc("app").set({ autoFakeLog: false }, { merge: true });
            return userNotifyBot.sendMessage(msg.chat.id, "🛑 <b>চ্যানেলে ফেক অর্ডার লগ পাঠানো বন্ধ (OFF) করা হয়েছে!</b>", { parse_mode: "HTML" });
        }
        if (text === "/logon") {
            isAutoFakeLogEnabled = true;
            await db.collection("config").doc("app").set({ autoFakeLog: true }, { merge: true });
            return userNotifyBot.sendMessage(msg.chat.id, "✅ <b>চ্যানেলে ফেক অর্ডার লগ পাঠানো চালু (ON) করা হয়েছে!</b>", { parse_mode: "HTML" });
        }

        // গ্লোবাল অ্যাডমিন চেক (ডুপ্লিকেট এরর মুক্ত)
        const ADMIN_ID_SAFE = "7504616242";
        const isSenderAdmin = msg.chat.id.toString() === ADMIN_ID_SAFE || (msg.from && msg.from.id.toString() === ADMIN_ID_SAFE);

        // অ্যাডমিন সরাসরি স্ল্যাশ কমান্ড দিয়ে কয়েন/টাকা যোগ-কাটা ও ব্যান-আনব্যান
        if (isFromAdmin && (text.startsWith("/add ") || text.startsWith("/cut ") || text.startsWith("/sub ") || text.startsWith("/deduct ") || text.startsWith("/addbonus ") || text.startsWith("/cutbonus ") || text.startsWith("/addtaka ") || text.startsWith("/cuttaka ") || text.startsWith("/ban ") || text.startsWith("/unban "))) {
            const parts = text.split(/\s+/).filter(Boolean);
            const cmd = parts[0].toLowerCase();
            const targetUid = parts[1] ? parts[1].trim() : "";
            const amtVal = parseFloat(parts[2]);

            if (cmd === "/ban") {
                const reason = parts.slice(2).join(" ").trim() || "নিয়ম ভঙ্গের কারণে আপনার অ্যাকাউন্ট সাময়িকভাবে স্থগিত করা হয়েছে।";
                if (!targetUid) return userNotifyBot.sendMessage(chatId, "💡 ব্যবহার: <code>/ban UID কারণ/নোটিশ</code>", { parse_mode: "HTML" });
                await cfFetch(`${CF_API}/api/user/ban`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: targetUid, banned: true, banReason: reason }) }).catch(() => {});
                await db.collection("users").doc(targetUid).set({ banned: true, banReason: reason, bannedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
                return userNotifyBot.sendMessage(chatId, `🚫 <b>ইউজার ব্যান করা হয়েছে!</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n📝 <b>নোটিশ:</b> <i>${safeTgHtml(reason)}</i>`, { parse_mode: "HTML" });
            }

            if (cmd === "/unban") {
                if (!targetUid) return userNotifyBot.sendMessage(chatId, "💡 ব্যবহার: <code>/unban UID</code>", { parse_mode: "HTML" });
                await cfFetch(`${CF_API}/api/user/ban`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: targetUid, banned: false, banReason: "" }) }).catch(() => {});
                await db.collection("users").doc(targetUid).set({ banned: false, banReason: "" }, { merge: true }).catch(() => {});
                return userNotifyBot.sendMessage(chatId, `✅ <b>ইউজার আনব্যান করা হয়েছে!</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>`, { parse_mode: "HTML" });
            }

            if (!targetUid || isNaN(amtVal)) {
                return userNotifyBot.sendMessage(chatId, "💡 <b>সঠিক নিয়ম:</b>\n👉 <code>/add UID 10</code> (Real Coin যোগ)\n👉 <code>/cut UID 5</code> (Real Coin কাটা)\n👉 <code>/addbonus UID 10</code> (Bonus Coin যোগ)\n👉 <code>/cutbonus UID 5</code> (Bonus Coin কাটা)\n👉 <code>/addtaka UID 50</code> (লাইভ টাকা যোগ)\n👉 <code>/cuttaka UID 20</code> (লাইভ টাকা কাটা)\n👉 <code>/ban UID নোটিশ</code> (ব্যান ও নোটিশ)\n👉 <code>/unban UID</code> (আনব্যান)", { parse_mode: "HTML" });
            }

            const absAmt = Math.abs(amtVal);

            if (cmd === "/addtaka" || cmd === "/cuttaka") {
                const isSub = (cmd === "/cuttaka");
                const change = isSub ? -absAmt : absAmt;
                let curLive = 0;
                try {
                    const uDoc = await db.collection("users").doc(targetUid).get();
                    curLive = Number((uDoc.exists && uDoc.data().playPoints) || 0);
                    const newLive = Math.max(0, Math.round((curLive + change + Number.EPSILON) * 100) / 100);
                    await db.collection("users").doc(targetUid).set({ playPoints: newLive }, { merge: true });
                    await cfFetch(`${CF_API}/api/wallet/credit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: targetUid, playPoints: newLive }) }).catch(() => {});
                    return userNotifyBot.sendMessage(chatId, `✅ <b>টাকা আপডেট সফল!</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n৳ <b>পরিবর্তন:</b> ${isSub ? '-' : '+'}${absAmt} Taka\n💰 <b>বর্তমান লাইভ টাকা:</b> ৳ ${newLive}`, { parse_mode: "HTML" });
                } catch(e) {
                    return userNotifyBot.sendMessage(chatId, `❌ টাকা আপডেট ব্যর্থ: ${e.message}`);
                }
            }

            // Coin Add/Cut
            const isBonus = (cmd === "/addbonus" || cmd === "/cutbonus");
            const isSub = (cmd === "/cut" || cmd === "/sub" || cmd === "/deduct" || cmd === "/cutbonus");
            const change = isSub ? -absAmt : absAmt;
            const coinType = isBonus ? "bonus" : "real";

            let curReal = 0, curBonus = 0, newTotal = 0;
            try {
                const uDoc = await db.collection("users").doc(targetUid).get();
                const ud = (uDoc.exists ? uDoc.data() : {}) || {};
                curReal = Number(ud.realBalance !== undefined ? ud.realBalance : (ud.balance || 0));
                curBonus = Number(ud.bonusBalance || 0);

                if (coinType === "real") {
                    curReal = Math.max(0, Math.round((curReal + change + Number.EPSILON) * 100) / 100);
                } else {
                    curBonus = Math.max(0, Math.round((curBonus + change + Number.EPSILON) * 100) / 100);
                }
                newTotal = Math.round((curReal + curBonus + Number.EPSILON) * 100) / 100;

                await db.collection("users").doc(targetUid).set({
                    realBalance: curReal,
                    bonusBalance: curBonus,
                    balance: newTotal,
                    uid: targetUid
                }, { merge: true });

                if (change < 0) {
                    await cfFetch(`${CF_API}/api/wallet/set-balance`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ uid: targetUid, balance: newTotal, realBalance: curReal, bonusBalance: curBonus })
                    }).catch(() => {});
                } else {
                    await cfFetch(`${CF_API}/api/wallet/credit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ uid: targetUid, coins: change, type: coinType })
                    }).catch(() => {});
                }

                return userNotifyBot.sendMessage(chatId,
                    `✅ <b>কয়েন আপডেট সফল!</b> [${coinType.toUpperCase()}]\n🆔 <b>UID:</b> <code>${targetUid}</code>\n🪙 <b>পরিবর্তন:</b> ${isSub ? '-' : '+'}${absAmt} Coins\n💰 <b>Real:</b> ${curReal} | 🎁 <b>Bonus:</b> ${curBonus}\n🪙 <b>মোট ব্যালেন্স:</b> ${newTotal} Coins`,
                    { parse_mode: "HTML" }
                );
            } catch(e) {
                return userNotifyBot.sendMessage(chatId, `❌ কয়েন আপডেট ব্যর্থ: ${e.message}`);
            }
        }

        let searchUid = null;
        if (isFromAdmin) {
            if (!text.startsWith("/") && text.length >= 10 && !text.includes(" ") && !text.includes("\n")) {
                searchUid = text;
            } else if (text.startsWith("/user ")) {
                searchUid = text.replace("/user ", "").trim();
            }
        }

        if (searchUid) {
            try {
                // ১. সবার আগে Cloudflare D1 এ ইউজার সার্চ (UID বা Email দুটোই কাজ করবে)
                const cfRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(searchUid)}`);
                const cfData = await cfRes.json();

                if (cfData && cfData.ok && cfData.user) {
                    const u = cfData.user;
                    const card = buildUserAdminCard(u.uid, u);
                    return await userNotifyBot.sendMessage(msg.chat.id, card.text, { 
                        parse_mode: "HTML", 
                        reply_markup: card.reply_markup 
                    });
                }

                // ২. ক্লাউডফ্লেয়ারে না পেলে ফায়ারস্টোর ফলব্যাক
                const uDoc = await db.collection("users").doc(searchUid).get();
                if (uDoc.exists) {
                    const card = buildUserAdminCard(searchUid, uDoc.data());
                    return await userNotifyBot.sendMessage(msg.chat.id, card.text, { 
                        parse_mode: "HTML", 
                        reply_markup: card.reply_markup 
                    });
                } else {
                    return await userNotifyBot.sendMessage(msg.chat.id, 
                        `❌ <code>${searchUid}</code> এই ইমেইল বা UID দিয়ে কোনো ইউজার পাওয়া যায়নি!`, 
                        { parse_mode: "HTML" }
                    );
                }
            } catch (err) {
                console.error("[ADMIN USER SEARCH ERR]:", err);
                return await userNotifyBot.sendMessage(msg.chat.id, `⚠️ ইউজার লোড করতে সমস্যা: ${err.message}`);
            }
        }

        if (replyTo && (text === "✅" || text === "❌" || text === "/approve" || text === "/reject" || text.toLowerCase() === "approve")) {
            const replyText = replyTo.text || replyTo.caption || "";
            const depMatch = replyText.match(/🆔\s*<b>DepID:<\/b>\s*<code>([A-Za-z0-9_-]+)<\/code>/i)
                          || replyText.match(/DepID:\s*([A-Za-z0-9_-]+)/i)
                          || replyText.match(/🔖\s*<b>TrxID:<\/b>\s*<code>([A-Za-z0-9_-]+)<\/code>/i);

            if (!depMatch) return;
            const identifier = depMatch[1].trim();

            if (text === "✅" || text === "/approve" || text.toLowerCase() === "approve") {
                let targetId = identifier;

                // রিপ্লাই মেসেজ থেকে TrxID, Amount ও Email সরাসরি এক্সট্র্যাক্ট করা (যদি ফায়ারস্টোর রিড বন্ধ থাকে)
                const trxMatch = replyText.match(/TrxID:\s*([A-Za-z0-9_-]+)/i);
                const amtMatch = replyText.match(/Amount:\s*([\d.]+)/i);
                const emailMatch = replyText.match(/User:.*?\((\S+@\S+)\)/i);

                const cleanTrx = trxMatch ? trxMatch[1].trim().toUpperCase() : identifier.toUpperCase();
                const cleanAmt = amtMatch ? Number(amtMatch[1]) : 15;
                const cleanEmail = emailMatch ? emailMatch[1].trim().replace(/\)/g, '') : "";

                try {
                    // ১. ইউজারকে Cloudflare D1 থেকে খোঁজা
                    let targetUid = "";
                    if (cleanEmail) {
                        try {
                            const uRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(cleanEmail)}`);
                            const uData = await uRes.json();
                            if (uData && uData.ok && uData.user) targetUid = uData.user.uid;
                        } catch (e) {}
                    }

                    const rate = 7;
                    const finalCoins = Math.max(1, Math.floor(cleanAmt / rate));

                    // approveDepositById কল করা (এটি Cloudflare D1 ও Firestore-এ একবারই নিরাপদভাবে প্রসেস করবে)
                    const approvedData = await approveDepositById(targetId, "Admin_Telegram");
                    if (approvedData && approvedData.alreadyApproved) {
                        await userNotifyBot.sendMessage(msg.chat.id, 
                            `⚠️ <b>এই ডিপোজিটটি ইতিমধ্যেই অ্যাপ্রুভ করা হয়েছে!</b>\n\n🔖 <b>TrxID:</b> <code>${cleanTrx}</code>`,
                            { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                        );
                        return;
                    }

                    await userNotifyBot.sendMessage(msg.chat.id, 
                        `✅ <b>DEPOSIT APPROVED SUCCESSFULLY!</b>\n\n` +
                        `👤 <b>User:</b> ${cleanEmail || "User"}\n` +
                        `🪙 <b>Coins Added:</b> +${finalCoins} PP Coins\n` +
                        `💵 <b>Amount:</b> ${cleanAmt} BDT\n` +
                        `🔖 <b>TrxID:</b> <code>${cleanTrx}</code>\n\n` +
                        `<i>ইউজারের একাউন্টে সফলভাবে কয়েন যোগ হয়েছে এবং TrxID লক করা হয়েছে! 🚀</i>`,
                        { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                    );
                } catch (err) {
                    await userNotifyBot.sendMessage(msg.chat.id, `⚠️ অ্যাপ্রুভ ব্যর্থ: ${err.message || 'Error'}`, { reply_to_message_id: msg.message_id });
                }
            } else if (text === "❌" || text === "/reject") {
                try {
                    await rejectDepositById(identifier);
                    await userNotifyBot.sendMessage(msg.chat.id, 
                        `❌ <b>ডিপোজিটটি বাতিল (Rejected) করা হয়েছে!</b>`,
                        { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                    );
                } catch (err) {
                    await userNotifyBot.sendMessage(msg.chat.id, `⚠️ রিজেক্ট ব্যর্থ: ${err.message}`, { reply_to_message_id: msg.message_id });
                }
            }
        }
    } catch (e) {}
});

// ---------------- ULTRA-FAST TELEGRAM REFERRAL & LEADERBOARD HELPERS (D1-FIRST) ----------------
async function sendReferralDashboard(chatId, userId, userName = "", userUsername = "", editMessageId = null) {
    try {
        let refCount = 0;
        let refBal = 0;

        // Cloudflare D1 থেকে ইনস্ট্যান্ট ফেচ (৫০ মিলিসেকেন্ড) এবং ফায়ারস্টোর ফাস্ট রেস
        try {
            const [uRes, uSnap] = await Promise.all([
                cfFetch(`${CF_API}/api/bot/user?id=${userId}`).then(r => r.json()).catch(() => null),
                Promise.race([
                    db.collection("tg_bot_users").doc(userId).get(),
                    new Promise(r => setTimeout(() => r(null), 1000))
                ]).catch(() => null)
            ]);

            if (uRes && uRes.ok && uRes.user) {
                refCount = Number(uRes.user.referralCount) || 0;
                refBal = Number(uRes.user.refBalance) || 0;
            }

            if (uSnap && uSnap.exists) {
                const fbD = uSnap.data();
                const fbCount = Number(fbD.referralCount) || 0;
                const fbBal = Number(fbD.refBalance) || 0;
                if (fbCount > refCount) {
                    refCount = fbCount;
                    refBal = fbBal;
                    // D1 ব্যাকগ্রাউন্ড আপডেট (SET, যাতে বারবার যোগ হয়ে সংখ্যা না বাড়ে)
                    cfFetch(`${CF_API}/api/bot/user/update`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: userId,
                            name: userName || "User",
                            username: userUsername || "",
                            referralCount: fbCount,
                            refBalance: fbBal
                        })
                    }).catch(() => {});
                }
            }
        } catch (e) {}

        // ভেরিফিকেশন গার্ড: আনভেরিফাইড ইউজারদের রেফারেল ড্যাশবোর্ড ব্লক থাকবে
        let isVerified = false;
        try {
            const uCheckDoc = await db.collection("tg_bot_users").doc(userId).get().catch(() => null);
            if (uCheckDoc && uCheckDoc.exists && uCheckDoc.data().isVerified) isVerified = true;
        } catch (e) {}

        if (!isVerified) {
            const unverifiedMsg = 
                `⚠️ <b>আপনার অ্যাকাউন্ট এখনও ভেরিফাইড নয়!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `রেফারেল লিংক তৈরি করতে ও বোনাস পেতে প্রথমে আপনার <b>ফোন নম্বর ও ওয়েবসাইট UID</b> দিয়ে ভেরিফিকেশন সম্পন্ন করুন।\n\n` +
                `👉 এখনই ভেরিফাই করতে নিচের <b>"🔐 একাউন্ট ভেরিফাই"</b> বাটনে চাপ দিন:`;
            
            const unverifiedKb = {
                inline_keyboard: [
                    [{ text: "🔐 একাউন্ট ভেরিফাই / Verify", callback_data: `verify_ref:none` }],
                    [{ text: "🏆 Top 10 Leaderboard", callback_data: "show_leaderboard" }]
                ]
            };

            if (editMessageId) {
                try {
                    return await userNotifyBot.editMessageText(unverifiedMsg, {
                        chat_id: chatId,
                        message_id: editMessageId,
                        parse_mode: "HTML",
                        reply_markup: unverifiedKb
                    });
                } catch (e) {}
            }
            return await userNotifyBot.sendMessage(chatId, unverifiedMsg, {
                parse_mode: "HTML",
                reply_markup: unverifiedKb
            });
        }

        const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
        const bonusPerRef = (publicCache && publicCache.config && publicCache.config.tgRefBonus !== undefined)
            ? Number(publicCache.config.tgRefBonus)
            : 0.5;

        const infoMsg = 
            `👥 <b>আপনার রেফারেল ড্যাশবোর্ড</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔗 <b>আপনার ইনভাইট লিংক:</b>\n<code>${refLink}</code>\n\n` +
            `💰 <b>রেফার ব্যালেন্স:</b> <b>${refBal} PP Coins</b>\n` +
            `📊 <b>মোট সফল রেফার:</b> <b>${refCount}</b> জন\n` +
            `🪙 <b>রেফার বোনাস:</b> প্রতি রেফারে <b>${bonusPerRef} Coins</b>\n` +
            `⚠️ <b>উইথড্র শর্ত:</b> ন্যূনতম ৩ কয়েন হলে কোড তৈরি করতে পারবেন।\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `<i>আপনার লিংক বন্ধুদের শেয়ার করুন এবং ব্যালেন্স জমিয়ে রিডিম কোড নিন!</i>`;

        const keyboard = {
            inline_keyboard: [
                [{ text: `🎁 রিডিম কোড তৈরি করুন (${refBal} Coins)`, callback_data: "withdraw_ref_code" }],
                [{ text: "🏆 লিডারবোর্ড দেখুন", callback_data: "show_leaderboard" }],
                [{ text: "📤 বন্ধুদের শেয়ার করুন", url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent("PP MOD-এ জয়েন করুন এবং জিতে নিন ফ্রি গুগল প্লে পয়েন্ট কয়েন!")}` }],
                [{ text: "🔄 Refresh Stats", callback_data: "my_ref_info" }]
            ]
        };

        if (editMessageId) {
            try {
                return await userNotifyBot.editMessageText(infoMsg, {
                    chat_id: chatId,
                    message_id: editMessageId,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
            } catch (err) {}
        }

        return await userNotifyBot.sendMessage(chatId, infoMsg, {
            parse_mode: "HTML",
            reply_markup: keyboard
        });
    } catch (e) {
        console.error("[sendReferralDashboard error]:", e.message);
    }
}

async function sendLeaderboard(chatId, userId, editMessageId = null) {
    try {
        let top10 = [];
        const now = Date.now();

        // ১. মেমোরি ক্যাশ চেক (১৫ সেকেন্ডের ক্যাশ থাকলে ইনস্ট্যান্ট ০ মিলিসেকেন্ডে রিটার্ন)
        if (cachedLeaderboardData.list && cachedLeaderboardData.list.length > 0 && (now - cachedLeaderboardData.updatedAt < 15000)) {
            top10 = cachedLeaderboardData.list;
        } else {
            // ২. Cloudflare D1 থেকে ইনস্ট্যান্ট ফেচ
            try {
                const lbRes = await cfFetch(`${CF_API}/api/bot/leaderboard`).then(r => r.json()).catch(() => null);
                if (lbRes && lbRes.ok && Array.isArray(lbRes.leaderboard) && lbRes.leaderboard.length > 0) {
                    top10 = lbRes.leaderboard;
                    cachedLeaderboardData.list = top10;
                    cachedLeaderboardData.updatedAt = now;
                }
            } catch (e) {}

            // ৩. যদি D1 এ ডাটা না থাকে, শুধুমাত্র তখনই ফায়ারস্টোর ব্যাকআপ (১.৫ সেকেন্ড টাইমআউট দিয়ে)
            if (top10.length === 0) {
                try {
                    const fbSnap = await Promise.race([
                        db.collection("tg_bot_users").orderBy("referralCount", "desc").limit(10).get(),
                        new Promise(r => setTimeout(() => r(null), 1500))
                    ]).catch(() => null);

                    if (fbSnap && !fbSnap.empty) {
                        fbSnap.forEach(docSnap => {
                            const d = docSnap.data();
                            const rCount = Number(d.referralCount || 0);
                            if (rCount > 0) {
                                top10.push({
                                    id: docSnap.id,
                                    name: d.name || d.username || "User",
                                    username: d.username || "",
                                    referralCount: rCount,
                                    refBalance: Number(d.refBalance || 0)
                                });
                            }
                        });
                        if (top10.length > 0) {
                            cachedLeaderboardData.list = top10;
                            cachedLeaderboardData.updatedAt = now;
                        }
                    }
                } catch (e) {}
            }
        }

        // ব্যবহারকারীর নিজের রেফারেল সংখ্যা বের করা (Cloudflare D1 থেকে ফাস্ট)
        let myRefCount = 0;
        try {
            const myRes = await cfFetch(`${CF_API}/api/bot/user?id=${userId}`).then(r => r.json()).catch(() => null);
            if (myRes && myRes.ok && myRes.user && myRes.user.referralCount) {
                myRefCount = Number(myRes.user.referralCount);
            }
        } catch (e) {}

        const isAdminViewer = isBotAdmin(userId);
        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
        let boardText = `🏆 <b>TOP 10 REFERRAL LEADERBOARD</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (top10.length === 0) {
            boardText += `<i>এখনো কোনো সফল রেফারেল ডাটা নেই। রেফার করে টপে চলে আসুন!</i>\n\n`;
        } else {
            top10.forEach((u, idx) => {
                const medal = medals[idx] || `[${idx + 1}]`;
                const isMe = u.id === userId ? " 👈 (আপনি)" : "";
                const cleanName = (u.name || "User").replace(/[<>&]/g, "").slice(0, 25);
                const uEarnings = Number(u.refBalance || 0);
                boardText += `${medal} <b>${cleanName}</b>${isMe}\n`;
                if (isAdminViewer) {
                    boardText += `   ├ 🆔 <b>UID:</b> <code>${u.id}</code> ${u.username ? '(' + u.username + ')' : ''}\n`;
                    boardText += `   ├ 👥 <b>রেফারেল:</b> <b>${u.referralCount}</b> জন\n`;
                    boardText += `   └ 💰 <b>মোট রেফার আয়:</b> <b>${uEarnings} PP Coins</b>\n\n`;
                } else {
                    boardText += `   └ 👥 সফল রেফার: <b>${u.referralCount}</b> জন\n\n`;
                }
            });
        }

        boardText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        boardText += `📍 <b>আপনার বর্তমান পজিশন:</b> <b>${myRefCount > 0 ? "Active" : "—"}</b>\n`;
        boardText += `👥 <b>আপনার মোট সফল রেফার:</b> <b>${myRefCount}</b> জন\n`;
        boardText += `🎯 <i>বন্ধুদের ইনভাইট করুন এবং টপ লিডারবোর্ডে জায়গা করে নিন!</i>`;

        const keyboard = {
            inline_keyboard: [
                [{ text: "🔄 Refresh Leaderboard", callback_data: "show_leaderboard" }],
                [{ text: "👥 Referral Stats", callback_data: "my_ref_info" }]
            ]
        };

        if (editMessageId) {
            try {
                return await userNotifyBot.editMessageText(boardText, {
                    chat_id: chatId,
                    message_id: editMessageId,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
            } catch (err) {}
        }

        return await userNotifyBot.sendMessage(chatId, boardText, {
            parse_mode: "HTML",
            reply_markup: keyboard
        });
    } catch (e) {
        console.error("[sendLeaderboard error]:", e.message);
    }
}

// ---------------- GUARANTEED USER COMMAND: /referr & /refer (INSTANT D1 - 0.1 SEC) ----------------
userNotifyBot.onText(/^\/(?:referr|refer|referral|ref)(?:@\w+)?(?:\s+(.+))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const isJoined = await enforceChannelMembership(chatId, userId);
    if (!isJoined) return;
    const userName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
    const userUsername = msg.from.username ? `@${msg.from.username}` : "";
    await sendReferralDashboard(chatId, userId, userName, userUsername, null);
});

// ---------------- GUARANTEED USER COMMAND: /leaderboard, /top & /lb (INSTANT D1) ----------------
userNotifyBot.onText(/^\/(?:leaderboard|top|lb)(?:@\w+)?(?:\s+(.+))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const isJoined = await enforceChannelMembership(chatId, userId);
    if (!isJoined) return;
    await sendLeaderboard(chatId, userId, null);
});

// ---------------- GUARANTEED USER COMMAND: /profile (INSTANT D1 - ZERO LAG) ----------------
userNotifyBot.onText(/^\/profile/i, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const isJoined = await enforceChannelMembership(chatId, userId);
        if (!isJoined) return;

        // Cloudflare D1 থেকে ইনস্ট্যান্ট লাইভ ব্যালেন্স ও ডাটা ফেচ
        let webUser = null;
        try {
            const cfRes = await cfFetch(`${CF_API}/api/user/find?q=${userId}`);
            const cfData = await cfRes.json();
            if (cfData && cfData.ok && cfData.user) {
                webUser = cfData.user;
            }
        } catch (e) {}

        let tgData = {};
        try {
            const snap = await Promise.race([
                db.collection("tg_bot_users").doc(userId).get(),
                new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 1500))
            ]);
            if (snap && snap.exists) tgData = snap.data();
        } catch (e) {}

        const name = (msg.from.first_name || "User").replace(/[<>&]/g, "");
        const username = msg.from.username ? `@${msg.from.username}` : "None";
        const coinsBal = webUser ? Number(webUser.balance || 0) : 0;
        const realBal = webUser ? Number(webUser.realBalance !== undefined ? webUser.realBalance : webUser.balance || 0) : 0;
        const bonusBal = webUser ? Number(webUser.bonusBalance || 0) : 0;
        const playPoints = webUser ? Number(webUser.playPoints || 0) : 0;
        const loyaltyStars = webUser ? Number(webUser.loyaltyStars || 0) : 0;
        const refBal = Number(tgData.refBalance || 0);

        const profileMsg = 
            `👤 <b>MY ACCOUNT PROFILE</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📛 <b>Name:</b> ${name}\n` +
            `✈️ <b>Username:</b> ${username}\n` +
            `🆔 <b>Telegram ID:</b> <code>${userId}</code>\n` +
            (webUser ? `🌐 <b>Web UID:</b> <code>${webUser.uid}</code>\n` : `🌐 <b>Web Status:</b> <i>Not Linked (ওয়েবসাইটে Profile > Connect Telegram এ এই ID দিন)</i>\n`) +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>Total PP Coins:</b> <b>${coinsBal} Coins</b>\n` +
            `   ├ 💰 Real: <b>${realBal}</b> | 🎁 Bonus: <b>${bonusBal}</b>\n` +
            `৳ <b>Taka Wallet:</b> <b>৳ ${playPoints}</b>\n` +
            `🎖️ <b>Loyalty Stars:</b> <b>${loyaltyStars} / 10 Stars</b>\n` +
            `👥 <b>Bot Refer Balance:</b> <b>${refBal} Coins</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🚀 <a href="https://ppmods.netlify.app/">Open PP MOD Web App</a>`;

        return userNotifyBot.sendMessage(chatId, profileMsg, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👥 রেফারেল ড্যাশবোর্ড", callback_data: "my_ref_info" }],
                    [{ text: "🏆 লিডারবোর্ড", callback_data: "show_leaderboard" }]
                ]
            }
        });
    } catch (e) {}
});

// Helper: Admin Bot Panel Builder
function buildAdminPanelPayload(queryOrMsg, currentBonus, autoDep, isFakeLog) {
    const adminUsername = (queryOrMsg.from && queryOrMsg.from.username) ? `@${queryOrMsg.from.username}` : "Admin";
    const panelText = 
        `⚡ <b>PP MOD EXECUTIVE ADMIN BOT PANEL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 <b>Admin:</b> Authorized (${adminUsername})\n` +
        `🎁 <b>Current Refer Bonus:</b> <b>${currentBonus} Coins / Invite</b>\n` +
        `⚡ <b>Auto Deposit Gateway:</b> ${autoDep ? '✅ ON' : '🛑 OFF'}\n` +
        `📢 <b>Channel Order Log:</b> ${isFakeLog ? '✅ ACTIVE' : '🛑 OFF'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>নিচের কন্ট্রোল বাটনগুলো দিয়ে ইনস্ট্যান্ট কনফিগার করুন:</i>`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: `➕ Ref Bonus (+0.1)`, callback_data: `panel_ref_mod:0.1` },
                { text: `➖ Ref Bonus (-0.1)`, callback_data: `panel_ref_mod:-0.1` }
            ],
            [
                { text: `Set 0.2c`, callback_data: `panel_ref_set:0.2` },
                { text: `Set 0.5c`, callback_data: `panel_ref_set:0.5` },
                { text: `Set 1.0c`, callback_data: `panel_ref_set:1.0` },
                { text: `Set 2.0c`, callback_data: `panel_ref_set:2.0` }
            ],
            [
                { text: autoDep ? "🛑 Disable Auto Dep" : "✅ Enable Auto Dep", callback_data: "panel_toggle_autodep" },
                { text: isFakeLog ? "🛑 Pause Order Log" : "✅ Resume Order Log", callback_data: "panel_toggle_fakelog" }
            ],
            [
                { text: "📊 Live Server Stats", callback_data: "panel_view_stats" },
                { text: "🔄 Refresh Panel", callback_data: "panel_refresh" }
            ]
        ]
    };
    return { text: panelText, reply_markup: keyboard };
}

// ---------------- SECRET ADMIN PANEL: panel544 / /panel544 (Strictly Authorized Admins) ----------------
userNotifyBot.onText(/^\/?panel544$/i, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const senderId = (msg.from && msg.from.id) ? msg.from.id.toString() : chatId.toString();

        if (!isBotAdmin(senderId)) return;

        let refBonus = (publicCache && publicCache.config && publicCache.config.tgRefBonus !== undefined)
            ? Number(publicCache.config.tgRefBonus)
            : 0.5;
        let autoDep = (publicCache && publicCache.config && publicCache.config.autoDeposit !== undefined)
            ? publicCache.config.autoDeposit
            : true;

        try {
            const cSnap = await db.collection("config").doc("app").get();
            if (cSnap.exists) {
                const cd = cSnap.data();
                if (cd.tgRefBonus !== undefined) refBonus = Number(cd.tgRefBonus);
                if (cd.autoDeposit !== undefined) autoDep = cd.autoDeposit;
                if (cd.autoFakeLog !== undefined) isAutoFakeLogEnabled = cd.autoFakeLog;
            }
        } catch (e) {}

        const payload = buildAdminPanelPayload(msg, refBonus, autoDep, isAutoFakeLogEnabled);
        return userNotifyBot.sendMessage(chatId, payload.text, {
            parse_mode: "HTML",
            reply_markup: payload.reply_markup
        });
    } catch (e) {}
});

userNotifyBot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const startParam = (match && match[1]) ? match[1].trim() : "";
        let inviterId = null;

        if (startParam.startsWith("ref_")) {
            inviterId = startParam.replace("ref_", "").trim();
            if (inviterId === userId) inviterId = null;
        }

        // ১. চ্যানেল ও গ্রুপ মেম্বারশিপ চেক (না থাকলে জয়েন বাটন দিয়ে আটকে দেবে)
        const isJoined = await enforceChannelMembership(chatId, userId);
        if (!isJoined) {
            // ইনভাইটার আইডি ব্যাকগ্রাউন্ডে সেভ করে রাখা যাতে জয়েন শেষে ভেরিফাই করলে রেফারার বোনাস পায়
            if (inviterId) {
                db.collection("tg_bot_users").doc(userId).set({
                    id: userId,
                    inviterId: inviterId
                }, { merge: true }).catch(() => {});
            }
            return;
        }

        // ২. ইউজার ভেরিফাইড কি না চেক করা
        let isVerified = false;
        try {
            const uDoc = await db.collection("tg_bot_users").doc(userId).get().catch(() => null);
            if (uDoc && uDoc.exists && uDoc.data().isVerified) isVerified = true;
        } catch (e) {}

        const cleanFirstName = (msg.from.first_name || "ইউজার").replace(/[<>&]/g, "");
        const welcomeText = 
            `👑 <b>WELCOME TO PP MOD OFFICIAL</b> 🚀\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👋 <b>হ্যালো, ${cleanFirstName}!</b>\n\n` +
            `🎁 <b>রেফারেল বোনাস অফার:</b>\n` +
            `প্রতি সফল রেফারে পাবেন <b>০.৫ PP Coins</b>! মাত্র <b>৩ কয়েন</b> জমলেই সরাসরি ফ্রি রিডিম কোড তুলে নিতে পারবেন।\n\n` +
            `⚡ <b>আমাদের অফিসিয়াল কমিউনিটি:</b>\n` +
            `├ 📢 <a href="https://t.me/googleplaypointhack">Main Channel</a>\n` +
            `├ 📋 <a href="https://t.me/ppmododderlog">All Order Logs</a>\n` +
            `├ 💬 <a href="https://t.me/GPPHMCOMMUNITY">Community Group</a>\n` +
            `└ 🔒 <a href="https://t.me/+s09ahNjWHZM4YWM9">VIP Private Access</a>\n\n` +
            (isVerified
                ? `✅ <b>আপনার অ্যাকাউন্ট সম্পূর্ণ ভেরিফাইড!</b>\nনিচের "👥 Referral Stats" বাটনে চাপ দিয়ে আপনার ইনভাইট লিংক দেখতে পারবেন।\n`
                : `📌 <b>ভেরিফিকেশন আবশ্যক:</b>\nফেক রেফারেল প্রতিরোধে বট ব্যবহার ও রেফারেল লিংক পেতে নিচের <b>"🔐 একাউন্ট ভেরিফাই"</b> বাটনে চাপ দিয়ে ফোন নম্বর ও ওয়েবসাইট UID ভেরিফাই করুন।\n`) +
            `━━━━━━━━━━━━━━━━━━━━━━`;

        const keyboard = getJoinKeyboard(userId, inviterId, isVerified);

        // স্থায়ী বাটন মেনু কীবোর্ড নিচে সেট করা
        userNotifyBot.sendMessage(chatId, "👇 <b>নিচের মেনু বাটন ব্যবহার করুন:</b>", {
            parse_mode: "HTML",
            reply_markup: getMainMenuReplyKeyboard(isVerified)
        }).catch(() => {});

        // ১. ইনস্ট্যান্ট ডেলিভারি (Zero Delay): cached file_id বা ব্যানার ইমেজ পাঠানো
        const sendPhotoTarget = cachedWelcomeBannerFileId || WELCOME_BANNER_IMG;
        userNotifyBot.sendPhoto(chatId, sendPhotoTarget, {
            caption: welcomeText,
            parse_mode: "HTML",
            reply_markup: keyboard
        }).then(sent => {
            if (sent && sent.photo && sent.photo.length) {
                cachedWelcomeBannerFileId = sent.photo[sent.photo.length - 1].file_id;
            }
        }).catch(() => {
            userNotifyBot.sendMessage(chatId, welcomeText, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: keyboard
            }).catch(() => {});
        });

        // ২. নন-ব্লকিং ব্যাকগ্রাউন্ডে ইউজার রেজিস্ট্রেশন ও সিঙ্ক (যাতে রেসপন্সে কোনো লেট না হয়)
        (async () => {
            try {
                const uName = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "User";
                const uUser = msg.from.username ? `@${msg.from.username}` : "";

                // Cloudflare D1-এ সিঙ্ক
                cfFetch(`${CF_API}/api/bot/user/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: userId,
                        name: uName,
                        username: uUser,
                        addRefCount: 0,
                        addRefBalance: 0
                    })
                }).catch(() => {});

                // Firestore-এ সিঙ্ক
                const userDoc = await db.collection("tg_bot_users").doc(userId).get().catch(() => null);
                if (!userDoc || !userDoc.exists) {
                    await db.collection("tg_bot_users").doc(userId).set({
                        id: userId,
                        name: uName,
                        username: uUser,
                        inviterId: inviterId || null,
                        isVerified: false,
                        referralCount: 0,
                        rewardsEarned: 0,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    }).catch(() => {});
                } else if (!userDoc.data().isVerified && inviterId && !userDoc.data().inviterId) {
                    await db.collection("tg_bot_users").doc(userId).set({ inviterId }, { merge: true }).catch(() => {});
                }
            } catch (syncErr) {
                console.error("[Bot /start Sync Error]:", syncErr.message);
            }
        })();

    } catch (e) {
        console.error("[Bot /start Main Error]:", e);
    }
});

userNotifyBot.on("callback_query", async (query) => {
    try {
        const chatId = query.message.chat.id;
        const userId = query.from.id.toString();
        const data = query.data || "";

        // Admin User Management Button Handlers (Superfast Cloudflare D1 Backend)
        if (data.startsWith("u_toggle_ban:")) {
            const targetUid = data.replace("u_toggle_ban:", "").trim();
            try {
                // ১. Cloudflare D1 থেকে বর্তমান ব্যান স্ট্যাটাস চেক
                const uRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(targetUid)}`);
                const uData = await uRes.json();
                const curBanned = uData && uData.user && (uData.user.banned === 1 || uData.user.banned === true);
                const nextBanned = !curBanned;

                // ২. Cloudflare D1 এ সাথে সাথে ব্যান/আনব্যান
                await cfFetch(`${CF_API}/api/user/ban`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uid: targetUid, banned: nextBanned })
                });

                // ফায়ারস্টোর ব্যাকগ্রাউন্ড সিঙ্ক
                db.collection("users").doc(targetUid).update({ banned: nextBanned }).catch(() => {});

                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: nextBanned ? "🚫 ইউজার ব্যান করা হয়েছে!" : "✅ ইউজার আনব্যান করা হয়েছে!",
                    show_alert: true
                });

                const freshObj = uData.user ? { ...uData.user, banned: nextBanned ? 1 : 0 } : { uid: targetUid, banned: nextBanned };
                const card = buildUserAdminCard(targetUid, freshObj);
                return userNotifyBot.editMessageText(card.text, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            } catch (e) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error: " + e.message });
            }
        }

        if (data.startsWith("u_ask_add_real:")) {
            const targetUid = data.replace("u_ask_add_real:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➕ <b>ব্যালেন্স যোগ করুন [REAL]</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত রিয়েল কয়েন যোগ করতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 10 বা 50):`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }

        if (data.startsWith("u_ask_sub_real:")) {
            const targetUid = data.replace("u_ask_sub_real:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➖ <b>ব্যালেন্স কাটুন [REAL]</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত রিয়েল কয়েন কাটতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 5 বা 20):`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }

        if (data.startsWith("u_ask_add_bonus:")) {
            const targetUid = data.replace("u_ask_add_bonus:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➕ <b>ব্যালেন্স যোগ করুন [BONUS]</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত বোনাস কয়েন যোগ করতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 5 বা 10):`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }

        if (data.startsWith("u_ask_sub_bonus:")) {
            const targetUid = data.replace("u_ask_sub_bonus:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➖ <b>ব্যালেন্স কাটুন [BONUS]</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত বোনাস কয়েন কাটতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 5 বা 10):`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }

        if (data.startsWith("u_mod_star:")) {
            const parts = data.split(":");
            const targetUid = parts[1];
            const change = Number(parts[2]) || 0;

            try {
                // ১. Cloudflare D1 থেকে বর্তমান স্টার আনা
                const uRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(targetUid)}`);
                const uData = await uRes.json();
                const cur = Number((uData && uData.user && uData.user.loyaltyStars) || 0);
                const newStars = Math.max(0, Math.min(10, cur + change));

                // ২. Cloudflare D1 এ সাথে সাথে স্টার আপডেট
                await cfFetch(`${CF_API}/api/wallet/set-balance`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uid: targetUid, loyaltyStars: newStars })
                });

                // ফায়ারস্টোর ব্যাকগ্রাউন্ড সিঙ্ক
                db.collection("users").doc(targetUid).update({ loyaltyStars: newStars }).catch(() => {});

                await userNotifyBot.answerCallbackQuery(query.id, { text: `⭐ Stars: ${newStars}/10 applied!` });
                const freshObj = uData.user ? { ...uData.user, loyaltyStars: newStars } : { uid: targetUid, loyaltyStars: newStars };
                const card = buildUserAdminCard(targetUid, freshObj);
                return userNotifyBot.editMessageText(card.text, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            } catch (e) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error: " + e.message });
            }
        }

        if (data.startsWith("u_refresh:")) {
            const targetUid = data.replace("u_refresh:", "").trim();
            const uSnap = await db.collection("users").doc(targetUid).get();
            if (uSnap.exists) {
                await userNotifyBot.answerCallbackQuery(query.id, { text: "Refreshed! 🔄" });
                const card = buildUserAdminCard(targetUid, uSnap.data());
                return userNotifyBot.editMessageText(card.text, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            }
        }

        if (data.startsWith("u_view:")) {
            const targetUid = data.replace("u_view:", "").trim();
            try {
                const cfRes = await cfFetch(`${CF_API}/api/user/find?q=${encodeURIComponent(targetUid)}`);
                const cfData = await cfRes.json();
                const uObj = (cfData && cfData.ok && cfData.user) ? cfData.user : { uid: targetUid };
                const card = buildUserAdminCard(targetUid, uObj);
                return userNotifyBot.sendMessage(chatId, card.text, {
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            } catch (e) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error loading user" });
            }
        }

        // ---------------- ORDER MANAGEMENT CALLBACKS (Zero Lag) ----------------
        if (data.startsWith("ord_complete:")) {
            const orderId = data.replace("ord_complete:", "").trim();
            try {
                let ordData = null;
                const ordDoc = await db.collection("orders").doc(orderId).get();
                if (ordDoc.exists) ordData = ordDoc.data();
                if (!ordData) {
                    const cfRes = await cfFetch(`${CF_API}/api/orders/status?id=${orderId}`);
                    const cfJson = await cfRes.json();
                    if (cfJson && cfJson.ok && cfJson.order) ordData = cfJson.order;
                }
                if (!ordData) return userNotifyBot.answerCallbackQuery(query.id, { text: "Order not found" });

                if (ordData.status === "completed") {
                    return userNotifyBot.answerCallbackQuery(query.id, { text: "Already completed!" });
                }

                // Firestore & Cloudflare D1 আপডেট
                await db.collection("orders").doc(orderId).update({
                    status: "completed",
                    adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false,
                    inQueue: false
                }).catch(() => {});

                await cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        orderId,
                        status: "completed",
                        adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                        inQueue: false
                    })
                }).catch(() => {});

                // লয়্যালটি স্টার ক্রেডিট
                if (ordData.uid && ordData.uid !== "guest") {
                    await cfFetch(`${CF_API}/api/wallet/credit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ uid: ordData.uid, loyaltyStarsInc: 1 })
                    }).catch(() => {});
                    db.collection("users").doc(ordData.uid).update({
                        loyaltyStars: admin.firestore.FieldValue.increment(1)
                    }).catch(() => {});
                }

                // ইউজারকে টেলিগ্রাম নোটিফিকেশন
                if (ordData.userTgId || ordData.uid) {
                    const notifyId = await getUserTgId(ordData.uid, ordData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${ordData.game || "Task"}\n` +
                        `🪙 <b>ফি:</b> ${ordData.amount || 3} PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    ).catch(() => {});
                }

                await userNotifyBot.answerCallbackQuery(query.id, { text: "✅ Task marked completed!", show_alert: true });

                const oldText = query.message.text || "";
                return userNotifyBot.editMessageText(
                    oldText + `\n\n✅ <b>STATUS: COMPLETED BY ADMIN (${new Date().toLocaleTimeString('en-GB')})</b>`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: "HTML"
                    }
                ).catch(() => {});
            } catch (err) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error: " + err.message });
            }
        }

        if (data.startsWith("ord_refund:")) {
            const orderId = data.replace("ord_refund:", "").trim();
            try {
                let ordData = null;
                const ordDoc = await db.collection("orders").doc(orderId).get();
                if (ordDoc.exists) ordData = ordDoc.data();
                if (!ordData) {
                    const cfRes = await cfFetch(`${CF_API}/api/orders/status?id=${orderId}`);
                    const cfJson = await cfRes.json();
                    if (cfJson && cfJson.ok && cfJson.order) ordData = cfJson.order;
                }
                if (!ordData) return userNotifyBot.answerCallbackQuery(query.id, { text: "Order not found" });

                if (ordData.status === "refunded") {
                    return userNotifyBot.answerCallbackQuery(query.id, { text: "Already refunded!" });
                }

                await refundOrder(orderId, ordData.uid, "❌ এডমিন দ্বারা টাস্কটি বাতিল ও কয়েন রিফান্ড করা হয়েছে।", ordData.userTgId);

                await userNotifyBot.answerCallbackQuery(query.id, { text: "❌ Order refunded!", show_alert: true });

                const oldText = query.message.text || "";
                return userNotifyBot.editMessageText(
                    oldText + `\n\n❌ <b>STATUS: REFUNDED BY ADMIN (${new Date().toLocaleTimeString('en-GB')})</b>`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: "HTML"
                    }
                ).catch(() => {});
            } catch (err) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error: " + err.message });
            }
        }

        if (data.startsWith("ord_ask_code:")) {
            const orderId = data.replace("ord_ask_code:", "").trim();
            try {
                const codePrompt = "🔑 আপনার ফোনের স্ক্রিনে ভেসে ওঠা জিমেইল সিকিউরিটি ভেরিফিকেশন কোড / ট্যাপ অনুমোদন করুন!";
                await db.collection("orders").doc(orderId).update({ adminMsg: codePrompt }).catch(() => {});
                await cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderId, adminMsg: codePrompt })
                }).catch(() => {});

                // ইউজারকে টেলিগ্রামেও বার্তা পাঠানো
                let ordData = null;
                const ordDoc = await db.collection("orders").doc(orderId).get();
                if (ordDoc.exists) ordData = ordDoc.data();
                if (ordData && (ordData.userTgId || ordData.uid)) {
                    const notifyId = await getUserTgId(ordData.uid, ordData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🔑 <b>জিমেইল কোড / ভেরিফিকেশন প্রয়োজন!</b>\n\n` +
                        `আপনার টাস্ক প্রসেস করার জন্য সিকিউরিটি অনুমোদন বা কোড দরকার। দয়া করে ফোনে আসা নোটিফিকেশনে ট্যাপ করুন অথবা অ্যাপে কোড দিন!`
                    ).catch(() => {});
                }

                await userNotifyBot.answerCallbackQuery(query.id, { text: "💬 Code request sent to user!", show_alert: true });
            } catch (err) {
                return userNotifyBot.answerCallbackQuery(query.id, { text: "Error: " + err.message });
            }
        }

        if (data.startsWith("ord_ask_msg:")) {
            const orderId = data.replace("ord_ask_msg:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `✉️ <b>ইউজারকে মেসেজ পাঠান</b>\n` +
                `🔖 <b>Order ID:</b> <code>${orderId}</code>\n\n` +
                `ইউজারের অ্যাপ ও টেলিগ্রামে যে মেসেজ দেখাতে চান, তা লিখে এই মেসেজে Reply দিন (যেমন: 'পাসওয়ার্ড ভুল, সঠিকটি দিন'):`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }

        if (data.startsWith("ord_refresh:")) {
            const orderId = data.replace("ord_refresh:", "").trim();
            let ordData = null;
            const ordDoc = await db.collection("orders").doc(orderId).get();
            if (ordDoc.exists) ordData = ordDoc.data();
            if (!ordData) {
                const cfRes = await cfFetch(`${CF_API}/api/orders/status?id=${orderId}`);
                const cfJson = await cfRes.json();
                if (cfJson && cfJson.ok && cfJson.order) ordData = cfJson.order;
            }
            if (ordData) {
                await userNotifyBot.answerCallbackQuery(query.id, { text: `Status: ${ordData.status} 🔄` });
            } else {
                await userNotifyBot.answerCallbackQuery(query.id, { text: "Refreshed!" });
            }
        }

        // ---------------- ADMIN PANEL CALLBACKS (panel544) ----------------
        if (data.startsWith("panel_ref_mod:") || data.startsWith("panel_ref_set:")) {
            if (!isBotAdmin(query.from.id)) return userNotifyBot.answerCallbackQuery(query.id, { text: "Unauthorized" });

            let newRate = 0.5;
            const curRate = (publicCache && publicCache.config && publicCache.config.tgRefBonus !== undefined)
                ? Number(publicCache.config.tgRefBonus)
                : 0.5;

            if (data.startsWith("panel_ref_mod:")) {
                const delta = parseFloat(data.replace("panel_ref_mod:", ""));
                newRate = Math.max(0.1, Math.round((curRate + delta + Number.EPSILON) * 100) / 100);
            } else {
                newRate = parseFloat(data.replace("panel_ref_set:", ""));
            }

            // ১. ইন-মেমোরি ক্যাশ সাথে সাথে আপডেট
            if (publicCache.config) publicCache.config.tgRefBonus = newRate;

            // ২. ফায়ারস্টোরে সেভ
            await db.collection("config").doc("app").set({ tgRefBonus: newRate }, { merge: true }).catch(() => {});
            await userNotifyBot.answerCallbackQuery(query.id, { text: `✅ Ref Bonus: ${newRate} Coins!` });

            // ৩. প্যানেল মেসেজ লাইভ এডিট
            const autoDep = (publicCache.config && publicCache.config.autoDeposit !== undefined) ? publicCache.config.autoDeposit : true;
            const payload = buildAdminPanelPayload(query, newRate, autoDep, isAutoFakeLogEnabled);

            return userNotifyBot.editMessageText(payload.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: payload.reply_markup
            }).catch(() => {});
        }

        if (data === "panel_toggle_autodep") {
            if (!isBotAdmin(query.from.id)) return userNotifyBot.answerCallbackQuery(query.id);
            const curState = (publicCache.config && publicCache.config.autoDeposit !== undefined) ? publicCache.config.autoDeposit : true;
            const nextState = !curState;
            if (publicCache.config) publicCache.config.autoDeposit = nextState;

            await db.collection("config").doc("app").set({ autoDeposit: nextState }, { merge: true }).catch(() => {});
            await userNotifyBot.answerCallbackQuery(query.id, { text: `Auto Deposit: ${nextState ? 'ON' : 'OFF'}` });

            const curRate = (publicCache.config && publicCache.config.tgRefBonus !== undefined) ? Number(publicCache.config.tgRefBonus) : 0.5;
            const payload = buildAdminPanelPayload(query, curRate, nextState, isAutoFakeLogEnabled);

            return userNotifyBot.editMessageText(payload.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: payload.reply_markup
            }).catch(() => {});
        }

        if (data === "panel_toggle_fakelog") {
            if (!isBotAdmin(query.from.id)) return userNotifyBot.answerCallbackQuery(query.id);
            isAutoFakeLogEnabled = !isAutoFakeLogEnabled;
            if (publicCache.config) publicCache.config.autoFakeLog = isAutoFakeLogEnabled;

            await db.collection("config").doc("app").set({ autoFakeLog: isAutoFakeLogEnabled }, { merge: true });
            await userNotifyBot.answerCallbackQuery(query.id, { text: `Channel Order Log: ${isAutoFakeLogEnabled ? 'ACTIVE' : 'OFF'}` });

            const curRate = (publicCache.config && publicCache.config.tgRefBonus !== undefined) ? Number(publicCache.config.tgRefBonus) : 0.5;
            const autoDep = (publicCache.config && publicCache.config.autoDeposit !== undefined) ? publicCache.config.autoDeposit : true;
            const payload = buildAdminPanelPayload(query, curRate, autoDep, isAutoFakeLogEnabled);

            return userNotifyBot.editMessageText(payload.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: payload.reply_markup
            }).catch(() => {});
        }

        if (data === "panel_view_stats") {
            if (!isBotAdmin(query.from.id)) return userNotifyBot.answerCallbackQuery(query.id);
            await userNotifyBot.answerCallbackQuery(query.id, { text: "Loading Stats..." });

            const [usersSnap, tgUsersSnap, depSnap] = await Promise.all([
                db.collection("users").count().get().catch(() => ({ data: () => ({ count: 0 }) })),
                db.collection("tg_bot_users").count().get().catch(() => ({ data: () => ({ count: 0 }) })),
                db.collection("deposits").where("status", "==", "pending").count().get().catch(() => ({ data: () => ({ count: 0 }) }))
            ]);

            const statsMsg = 
                `📊 <b>LIVE SYSTEM STATISTICS</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👥 <b>Web Users:</b> ${usersSnap.data().count} accounts\n` +
                `🤖 <b>Bot Verified Users:</b> ${tgUsersSnap.data().count} users\n` +
                `⏳ <b>Pending Deposits:</b> ${depSnap.data().count} requests\n` +
                `🔋 <b>Active Prime Clients:</b> ${primeClients.size} online\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;

            return userNotifyBot.sendMessage(chatId, statsMsg, { parse_mode: "HTML" });
        }

        if (data === "panel_refresh") {
            if (!isBotAdmin(query.from.id)) return userNotifyBot.answerCallbackQuery(query.id);
            await userNotifyBot.answerCallbackQuery(query.id, { text: "Refreshed!" });

            let curRate = 0.5, autoDep = true, isFake = isAutoFakeLogEnabled;
            try {
                const cSnap = await db.collection("config").doc("app").get();
                if (cSnap.exists) {
                    const cd = cSnap.data();
                    if (cd.tgRefBonus !== undefined) curRate = Number(cd.tgRefBonus);
                    if (cd.autoDeposit !== undefined) autoDep = cd.autoDeposit;
                    if (cd.autoFakeLog !== undefined) {
                        isFake = cd.autoFakeLog;
                        isAutoFakeLogEnabled = isFake;
                    }
                    if (publicCache.config) publicCache.config = { ...publicCache.config, ...cd };
                }
            } catch (e) {}

            const payload = buildAdminPanelPayload(query, curRate, autoDep, isFake);
            return userNotifyBot.editMessageText(payload.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: payload.reply_markup
            }).catch(() => {});
        }

        if (data.startsWith("verify_ref:")) {
            userNotifyBot.answerCallbackQuery(query.id).catch(() => {});

            const isAllJoined = await checkUserMembership(userId);
            if (!isAllJoined) {
                return userNotifyBot.sendMessage(chatId,
                    `❌ <b>আপনি এখনও সব চ্যানেলে জয়েন করেননি!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `দয়া করে নিচের চ্যানেলে জয়েন করে পুনরায় চেষ্টা করুন:\n` +
                    `👉 <a href="${FOLDER_INVITE_LINK}">1-Click All Channels Folder</a>`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "🚀 Join Channels (1-Click)", url: FOLDER_INVITE_LINK }],
                                [{ text: "🔄 জয়েন করেছি, চেক করুন", callback_data: "recheck_channels" }]
                            ]
                        }
                    }
                );
            }

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

            if (userData.isVerified) {
                return userNotifyBot.sendMessage(chatId, "✅ <b>আপনি ইতিমধ্যে সম্পূর্ণ ভেরিফাইড!</b>", {
                    parse_mode: "HTML",
                    reply_markup: getMainMenuReplyKeyboard(true)
                });
            }

            // ১২ ঘণ্টার লকআউট চেক
            if (userData.captchaLockedUntil) {
                const lockMs = Number(userData.captchaLockedUntil) - Date.now();
                if (lockMs > 0) {
                    const hoursLeft = Math.floor(lockMs / (1000 * 60 * 60));
                    const minsLeft = Math.ceil((lockMs % (1000 * 60 * 60)) / (1000 * 60));
                    return userNotifyBot.answerCallbackQuery(query.id, {
                        text: `🚫 আপনার ভেরিফিকেশন ১২ ঘণ্টার জন্য লক করা আছে! আর ${hoursLeft} ঘণ্টা ${minsLeft} মিনিট পর চেষ্টা করুন।`,
                        show_alert: true
                    });
                }
            }

            const dataParts = data.split(":");
            const passedInviterId = (dataParts[1] && dataParts[1] !== "none") ? dataParts[1].trim() : null;
            const targetInviterId = userData.inviterId || passedInviterId;

            // ইনভাইটার আইডি সেভ করা
            if (targetInviterId && targetInviterId !== userId) {
                await userRef.set({
                    id: userId,
                    inviterId: targetInviterId
                }, { merge: true });
            }

            await userNotifyBot.answerCallbackQuery(query.id);

            // যদি ফোন নম্বর আগেই শেয়ার করা থাকে, সরাসরি ক্যাপচা শুরু করবে
            if (userData.phone) {
                return sendRandomCaptcha(chatId, userId, query.message ? query.message.message_id : null);
            }

            // অন্যথায় ফোন কন্টাক্ট শেয়ারের প্রম্পট পাঠাবে
            return userNotifyBot.sendMessage(chatId,
                `🛡️ <b>অ্যাকাউন্ট ভেরিফিকেশন (ধাপ ১ / ২)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `বট ব্যবহার ও রেফারেল সুবিধা পেতে নিচের ২টি সহজ ধাপ সম্পন্ন করুন:\n\n` +
                `📱 <b>ধাপ ১:</b> নিচের <b>"📱 Share Contact / ফোন নম্বর ভেরিফাই"</b> বাটনে চাপ দিন (শুধুমাত্র রিয়েল অ্যাকাউন্ট নিশ্চিত করতে)।\n` +
                `🧩 <b>ধাপ ২:</b> রোবট প্রতিরোধ ক্যাপচা পূরণ করুন।\n\n` +
                `⚠️ <b>অনুমোদিত দেশসমূহ:</b>\n` +
                `🇧🇩 বাংলাদেশ (+880) | 🇮🇳 ভারত (+91) | 🇵🇰 পাকিস্তান (+92)\n` +
                `🇪🇬 মিশর (+20) | 🇸🇦 সৌদি আরব (+966) | 🇦🇪 দুবাই (+971) | 🇮🇷 ইরান (+98)\n` +
                `<i>(অন্যান্য দেশের কোনো ভার্চুয়াল নম্বর গ্রহণযোগ্য নয়)</i>\n━━━━━━━━━━━━━━━━━━━━━━`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        keyboard: [
                            [{ text: "📱 Share Contact / ফোন নম্বর ভেরিফাই", request_contact: true }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
        }

        // ---------------- STEP 2: CAPTCHA START CALLBACK ----------------
        if (data === "start_captcha") {
            const isAllJoined = await checkUserMembership(userId);
            if (!isAllJoined) {
                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: "❌ আপনি সবগুলো চ্যানেলে জয়েন করেননি! সবগুলোতে জয়েন করে আবার চাপুন।",
                    show_alert: true
                });
                return enforceChannelMembership(chatId, userId);
            }

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

            if (userData.isVerified) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "✅ আপনি ইতিমধ্যে ভেরিফাইড!",
                    show_alert: true
                });
            }

            // ১২ ঘণ্টার লকআউট চেক
            if (userData.captchaLockedUntil) {
                const lockMs = Number(userData.captchaLockedUntil) - Date.now();
                if (lockMs > 0) {
                    const hoursLeft = Math.floor(lockMs / (1000 * 60 * 60));
                    const minsLeft = Math.ceil((lockMs % (1000 * 60 * 60)) / (1000 * 60));
                    return userNotifyBot.answerCallbackQuery(query.id, {
                        text: `🚫 আপনার ভেরিফিকেশন ১২ ঘণ্টার জন্য লক করা আছে! আর ${hoursLeft} ঘণ্টা ${minsLeft} মিনিট পর চেষ্টা করুন।`,
                        show_alert: true
                    });
                }
            }

            // আগে ফোন শেয়ার করা আছে কি না যাচাই
            if (!userData.phone) {
                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: "📱 প্রথমে ধাপ ১ (ফোন নম্বর শেয়ার) সম্পন্ন করুন!",
                    show_alert: true
                });
                return userNotifyBot.sendMessage(chatId,
                    `📱 <b>ধাপ ১: ফোন নম্বর শেয়ার করুন</b>\n\nনিচের বাটনে চাপ দিয়ে আপনার নিজস্ব টেলিগ্রাম অ্যাকাউন্টের কন্টাক্ট শেয়ার করুন:`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            keyboard: [[{ text: "📱 Share Contact / ফোন নম্বর ভেরিফাই", request_contact: true }]],
                            resize_keyboard: true,
                            one_time_keyboard: true
                        }
                    }
                );
            }

            await userNotifyBot.answerCallbackQuery(query.id);
            return sendRandomCaptcha(chatId, userId, query.message ? query.message.message_id : null);
        }

        // ---------------- CAPTCHA ANSWER HANDLER (WITH 12-HOUR LOCKOUT) ----------------
        if (data.startsWith("cpt_ans:")) {
            const parts = data.split(":");
            const tok = parts[1];
            const chosen = parts[2];

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

            // ১. ১২ ঘণ্টার লকআউট চেক
            if (userData.captchaLockedUntil) {
                const lockMs = Number(userData.captchaLockedUntil) - Date.now();
                if (lockMs > 0) {
                    const hoursLeft = Math.floor(lockMs / (1000 * 60 * 60));
                    const minsLeft = Math.ceil((lockMs % (1000 * 60 * 60)) / (1000 * 60));
                    return userNotifyBot.answerCallbackQuery(query.id, {
                        text: `🚫 আপনার ভেরিফিকেশন ১২ ঘণ্টার জন্য লক! আর ${hoursLeft} ঘণ্টা ${minsLeft} মিনিট পর চেষ্টা করুন।`,
                        show_alert: true
                    });
                }
            }

            const pending = pendingCaptchas.get(userId);
            if (!pending || pending.token !== tok || Date.now() > pending.expires) {
                pendingCaptchas.delete(userId);
                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: "⌛ ক্যাপচার সময় শেষ হয়ে গেছে! নতুন ক্যাপচা পাঠানো হচ্ছে।",
                    show_alert: true
                });
                return sendRandomCaptcha(chatId, userId, query.message ? query.message.message_id : null);
            }

            // ২. ক্যাপচা উত্তর চেক করা
            if (chosen === pending.correctEmoji) {
                // ✅ সঠিক উত্তর — সম্পূর্ণ ভেরিফাইড!
                pendingCaptchas.delete(userId);

                await userRef.set({
                    id: userId,
                    isVerified: true,
                    verificationStage: "completed",
                    captchaLockedUntil: null,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                const uName = `${query.from.first_name || ""} ${query.from.last_name || ""}`.trim() || "User";
                const uUsername = query.from.username ? `@${query.from.username}` : "";

                // Cloudflare D1 সিঙ্ক
                cfFetch(`${CF_API}/api/bot/user/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: userId,
                        name: uName,
                        username: uUsername,
                        phone: userData.phone || "",
                        isVerified: 1
                    })
                }).catch(() => {});

                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: "🎉 ক্যাপচা সফল হয়েছে! আপনি সম্পূর্ণ ভেরিফাইড।",
                    show_alert: true
                });

                // ভেরিফাইড ইউজার মেনু কীবোর্ড সক্রিয় করা
                userNotifyBot.sendMessage(chatId, "✅ <b>আপনার অ্যাকাউন্ট সফলভাবে ভেরিফাইড হয়েছে!</b>", {
                    parse_mode: "HTML",
                    reply_markup: getMainMenuReplyKeyboard(true)
                }).catch(() => {});

                const successMsg = 
                    `🎉 <b>অভিনন্দন! আপনার অ্যাকাউন্ট সফলভাবে সম্পূর্ণ ভেরিফাইড হয়েছে!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 ফোন নম্বর: <b>+${userData.phone || "Verified"}</b>\n` +
                    `🧩 ক্যাপচা স্ট্যাটাস: <b>উত্তীর্ণ (মানব ব্যবহারকারী)</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `এখন থেকে আপনি সম্পূর্ণ সুরক্ষিতভাবে বট ব্যবহার করতে পারবেন এবং বন্ধুদের রেফার করে কয়েন জিততে পারবেন!`;

                const successKb = {
                    inline_keyboard: [
                        [{ text: "👥 আমার রেফারেল ড্যাশবোর্ড", callback_data: "my_ref_info" }],
                        [{ text: "🏆 লিডারবোর্ড দেখুন", callback_data: "show_leaderboard" }]
                    ]
                };

                if (query.message) {
                    try {
                        await userNotifyBot.editMessageText(successMsg, {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            parse_mode: "HTML",
                            reply_markup: successKb
                        });
                    } catch (e) {
                        await userNotifyBot.sendMessage(chatId, successMsg, { parse_mode: "HTML", reply_markup: successKb });
                    }
                } else {
                    await userNotifyBot.sendMessage(chatId, successMsg, { parse_mode: "HTML", reply_markup: successKb });
                }

                // ৩. রেফারারকে বোনাস প্রদান (+০.৫ Coins ও +১ রেফারেল)
                const targetInviterId = userData.inviterId;
                if (targetInviterId && targetInviterId !== userId) {
                    const bonusToAdd = (publicCache && publicCache.config && publicCache.config.tgRefBonus !== undefined)
                        ? Number(publicCache.config.tgRefBonus)
                        : 0.5;

                    let newCount = 1;
                    let newBal = bonusToAdd;

                    let inviterName = "User";
                    let inviterUsername = "";
                    try {
                        const invChat = await userNotifyBot.getChat(targetInviterId).catch(() => null);
                        if (invChat) {
                            inviterName = `${invChat.first_name || ""} ${invChat.last_name || ""}`.trim() || invChat.username || "User";
                            inviterUsername = invChat.username ? `@${invChat.username}` : "";
                        }
                    } catch (e) {}

                    try {
                        const refUpRes = await cfFetch(`${CF_API}/api/bot/user/update`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                id: targetInviterId,
                                name: inviterName,
                                username: inviterUsername,
                                addRefCount: 1,
                                addRefBalance: bonusToAdd
                            })
                        });
                        const refUpData = await refUpRes.json().catch(() => null);
                        if (refUpData && refUpData.ok) {
                            newCount = refUpData.referralCount;
                            newBal = refUpData.refBalance;
                        }
                    } catch (e) {}

                    db.collection("tg_bot_users").doc(targetInviterId).set({
                        id: targetInviterId,
                        referralCount: admin.firestore.FieldValue.increment(1),
                        refBalance: admin.firestore.FieldValue.increment(bonusToAdd)
                    }, { merge: true }).catch(() => {});

                    await userNotifyBot.sendMessage(targetInviterId,
                        `🎉 <b>নতুন সম্পূর্ণ ভেরিফাইড রেফার!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 ইউজার: <b>${safeTgHtml(query.from.first_name || "User")}</b>\n` +
                        `📱 ফোন ও ক্যাপচা ভেরিফিকেশন সফলভাবে সম্পন্ন হয়েছে।\n` +
                        `🪙 <b>+${bonusToAdd} PP Coins</b> আপনার রেফার ব্যালেন্সে যুক্ত হয়েছে!\n\n` +
                        `💰 বর্তমান ব্যালেন্স: <b>${newBal} PP Coins</b>\n` +
                        `👥 মোট সফল রেফার: <b>${newCount}</b> জন\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});
                }

                return;
            } else {
                // ❌ ভুল উত্তর -> সরাসরি ১২ ঘণ্টার জন্য ভেরিফিকেশন লক!
                pendingCaptchas.delete(userId);
                const lockDuration = 12 * 60 * 60 * 1000; // ১২ ঘণ্টা
                const lockedUntil = Date.now() + lockDuration;

                await userRef.set({
                    captchaLockedUntil: lockedUntil
                }, { merge: true }).catch(() => {});

                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: "❌ ভুল উত্তর! আপনার ভেরিফিকেশন ১২ ঘণ্টার জন্য লক করা হয়েছে।",
                    show_alert: true
                });

                const lockMsg = 
                    `❌ <b>ভুল উত্তর! ভেরিফিকেশন ১২ ঘণ্টা লক</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `আপনি সঠিক ইমোজিতে চাপ দেননি। রোবট ও ফেক রেফারেল প্রতিরোধের জন্য আপনার অ্যাকাউন্ট ভেরিফিকেশন <b>১২ ঘণ্টার জন্য লক</b> করা হয়েছে।\n\n` +
                    `⏳ <b>লক খোলার সময়:</b> ১২ ঘণ্টা পর আপনি পুনরায় ভেরিফাই করার সুযোগ পাবেন।\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━`;

                if (query.message) {
                    try {
                        return await userNotifyBot.editMessageText(lockMsg, {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            parse_mode: "HTML"
                        });
                    } catch (e) {}
                }
                return await userNotifyBot.sendMessage(chatId, lockMsg, { parse_mode: "HTML" });
            }
        }

        if (data === "recheck_channels") {
            const isAllJoined = await checkUserMembership(userId);
            if (!isAllJoined) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "❌ এখনও সবগুলো চ্যানেল/গ্রুপে জয়েন পাওয়া যায়নি! দয়া করে নিশ্চিত করুন আপনি ৩টি চ্যানেল/গ্রুপেই জয়েন করেছেন।",
                    show_alert: true
                });
            }

            await userNotifyBot.answerCallbackQuery(query.id, {
                text: "✅ চ্যানেল জয়েন নিশ্চিত হয়েছে!",
                show_alert: false
            });

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get().catch(() => null);
            const userData = (userSnap && userSnap.exists) ? userSnap.data() : {};

            if (userData.isVerified) {
                return userNotifyBot.sendMessage(chatId, "✅ আপনি ইতিমধ্যে ভেরিফাইড! বট ব্যবহার করতে পারেন।");
            }

            // ১২ ঘণ্টা লকআউট চেক
            if (userData.captchaLockedUntil) {
                const lockMs = Number(userData.captchaLockedUntil) - Date.now();
                if (lockMs > 0) {
                    const hoursLeft = Math.floor(lockMs / (1000 * 60 * 60));
                    const minsLeft = Math.ceil((lockMs % (1000 * 60 * 60)) / (1000 * 60));
                    return userNotifyBot.sendMessage(chatId, `🚫 আপনার ভেরিফিকেশন ১২ ঘণ্টার জন্য লক! আর ${hoursLeft} ঘণ্টা ${minsLeft} মিনিট পর চেষ্টা করুন।`);
                }
            }

            if (userData.phone) {
                return sendRandomCaptcha(chatId, userId, null);
            }

            return userNotifyBot.sendMessage(chatId,
                `🛡️ <b>অ্যাকাউন্ট ভেরিফিকেশন (ধাপ ১ / ২)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `বট ব্যবহার ও রেফারেল সুবিধা পেতে নিচের বাটনে চাপ দিয়ে ফোন নম্বর শেয়ার করুন:\n\n` +
                `⚠️ <b>অনুমোদিত দেশ:</b> বাংলাদেশ (+880), ভারত (+91), পাকিস্তান (+92), মিশর (+20), সৌদি আরব (+966), দুবাই (+971), ইরান (+98)।`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        keyboard: [
                            [{ text: "📱 Share Contact / ফোন নম্বর ভেরিফাই", request_contact: true }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
        }

        if (data === "my_ref_info") {
            const userName = `${query.from.first_name || ""} ${query.from.last_name || ""}`.trim();
            const userUsername = query.from.username ? `@${query.from.username}` : "";
            await sendReferralDashboard(chatId, userId, userName, userUsername, query.message ? query.message.message_id : null);
            return;
        }

        // ---------------- DYNAMIC REDEEM CODE WITHDRAW HANDLER ----------------
        if (data === "withdraw_ref_code") {
            const uRef = db.collection("tg_bot_users").doc(userId);
            
            try {
                // Cloudflare D1 থেকে লাইভ ব্যালেন্স চেক করে Firestore আপডেট
                try {
                    const cfU = await cfFetch(`${CF_API}/api/bot/user?id=${userId}`).then(r => r.json()).catch(() => null);
                    if (cfU && cfU.ok && cfU.user && Number(cfU.user.refBalance || 0) > 0) {
                        const d1Bal = Number(cfU.user.refBalance);
                        const curDoc = await uRef.get().catch(() => null);
                        const fbBal = (curDoc && curDoc.exists) ? Number(curDoc.data().refBalance || 0) : 0;
                        if (d1Bal > fbBal) {
                            await uRef.set({ refBalance: d1Bal }, { merge: true }).catch(() => {});
                        }
                    }
                } catch (e) {}

                let codeGenerated = null;
                let withdrawnAmount = 0;

                await db.runTransaction(async (t) => {
                    const uSnap = await t.get(uRef);
                    if (!uSnap.exists) throw new Error("NO_USER");
                    const uData = uSnap.data();
                    const curBal = Number(uData.refBalance || 0);

                    if (curBal < 3) {
                        throw new Error("LOW_BALANCE");
                    }

                    withdrawnAmount = Math.round((curBal + Number.EPSILON) * 100) / 100;
                    codeGenerated = generateReferralCode();

                    // ব্যালেন্স ০ করা এবং উইথড্র লগ রাখা
                    t.update(uRef, {
                        refBalance: 0,
                        totalWithdrawn: admin.firestore.FieldValue.increment(withdrawnAmount),
                        lastWithdrawnAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    // codes কালেকশনে ফুল ব্যালেন্সের কোড তৈরি
                    const codeRef = db.collection("codes").doc(codeGenerated);
                    t.set(codeRef, {
                        amount: withdrawnAmount,
                        maxUses: 1,
                        used: 0,
                        active: true,
                        creatorTgId: userId,
                        note: `Referral Balance Withdrawal (${withdrawnAmount} Coins)`,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                });

                // Cloudflare D1 ব্যালেন্স রিডিউস করা
                cfFetch(`${CF_API}/api/bot/user/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: userId,
                        name: query.from.first_name || "User",
                        username: query.from.username ? `@${query.from.username}` : "",
                        addRefCount: 0,
                        addRefBalance: -withdrawnAmount
                    })
                }).catch(() => {});

                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: `✅ ${withdrawnAmount} Coins-এর রিডিম কোড তৈরি হয়েছে!`,
                    show_alert: true
                });

                const successMsg = 
                    `🎁 <b>অভিনন্দন! রিডিম কোড সফলভাবে তৈরি হয়েছে!</b> 🎉\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🪙 <b>কয়েন পরিমাণ:</b> <b>${withdrawnAmount} PP Coins</b>\n` +
                    `🔖 <b>আপনার রিডিম কোড:</b>\n<code>${codeGenerated}</code>\n\n` +
                    `👉 <b>ক্লেইম করার নিয়ম:</b>\n` +
                    `১. কোডটি কপি করতে কোডের ওপর চাপুন।\n` +
                    `২. <b>PP MOD</b> অ্যাপ ওপেন করে <b>Profile > Redeem Code</b> বক্সে কোডটি পেস্ট করুন।\n` +
                    `৩. সাথে সাথে আপনার ওয়ালেটে <b>${withdrawnAmount} PP Coins</b> যোগ হয়ে যাবে! 🚀\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━`;

                return userNotifyBot.sendMessage(chatId, successMsg, { parse_mode: "HTML" });

            } catch (err) {
                if (err.message === "LOW_BALANCE") {
                    const curDoc = await uRef.get();
                    const nowBal = curDoc.exists ? (curDoc.data().refBalance || 0) : 0;
                    const needed = Math.max(0, Math.round((3 - nowBal) * 100) / 100);
                    return userNotifyBot.answerCallbackQuery(query.id, {
                        text: `❌ ন্যূনতম ৩ কয়েন লাগবে!\nআপনার ব্যালেন্স: ${nowBal} Coins। আরো ${needed} Coins প্রয়োজন।`,
                        show_alert: true
                    });
                }
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "⚠️ কোড তৈরিতে সমস্যা হয়েছে! আবার চেষ্টা করুন।",
                    show_alert: true
                });
            }
        }

        // ---------------- LEADERBOARD HANDLER (ULTRA-FAST D1 - ZERO LAG) ----------------
        if (data === "show_leaderboard") {
            await sendLeaderboard(chatId, userId, query.message ? query.message.message_id : null);
            return;
        }
    } catch (e) {}
});

// ---------------- 6. MULTI-PRIME AUTO-RESPONDER (many accounts, same time) ----------------
function attachPrimeHandler(client, label) {
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg || msg.out) return;

            // ১. কঠোর গ্রুপ/চ্যানেল ফিল্টার: কোনো গ্রুপ বা চ্যানেলের মেসেজ হলে পুরোপুরি বাদ
            if (msg.isGroup || msg.isChannel) return;
            if (msg.peerId && (msg.peerId.className === "PeerChat" || msg.peerId.className === "PeerChannel")) return;

            // শুধুমাত্র ইউজার-টু-ইউজার ১-অন-১ প্রাইভেট ইনবক্স নিশ্চিত করা
            const isStrictPrivateUser = (msg.peerId && msg.peerId.className === "PeerUser") || (msg.isPrivate && !msg.isGroup);
            if (!isStrictPrivateUser) return;

            let sender = null;
            try { sender = await msg.getSender(); } catch (e) {}
            if (sender && sender.bot) return; // অন্য কোনো বটের মেসেজে রিপ্লাই দেবে না

            let senderId = (sender && sender.id) ? sender.id.toString() : null;
            if (!senderId && msg.senderId) senderId = msg.senderId.toString();
            if (!senderId && msg.peerId && msg.peerId.userId) senderId = msg.peerId.userId.toString();
            if (!senderId) return;

            // মেসেজের টেক্সট পরীক্ষা (বাংলা বা ইংরেজিতে লিংক চেয়েছে কিনা)
            const incomingText = (msg.message || "").toLowerCase().trim();
            const isAskingLink = /(?:^|\s)(?:link|links|site|website|web|লিংক|লেংক|সাইট|ওয়েবসাইট)(?:$|\s|[?!.,])/i.test(incomingText)
                                || incomingText.includes("link")
                                || incomingText.includes("লিংক")
                                || incomingText.includes("লেংক");

            const LINK_REPLY_TEXT = `🔗 <b>PP MOD অফিশিয়াল ওয়েবসাইট লিংক:</b>\n\n` +
                                   `আমাদের সমস্ত কোয়েস্ট ও সার্ভিস ব্যবহার করতে নিচের লিংকে ক্লিক করুন:\n` +
                                   `👉 <a href="https://ppmods.netlify.app/">https://ppmods.netlify.app/</a>\n\n` +
                                   `⚡ <i>মাত্র ৩ সেকেন্ডে প্লে পয়েন্ট টাস্ক সম্পন্ন করুন!</i> ✨`;

            // ২. দিনে কঠোরভাবে ঠিক ১ বার (Strict 1-Time Daily across all primes) অটো-রিপ্লাই চেক
            // বাংলাদেশ সময় রাত ১২:০০ টা (UTC+6 Midnight) এ নতুন দিন শুরু হলেই কেবল রিপ্লাই পাবে
            const canReplyToday = await primeCooldownClaim(senderId);

            if (canReplyToday) {
                console.log(`[PRIME] 📩 Strict 1-Time Daily Reply to [${senderId}] on [${label}]...`);
                await new Promise((r) => setTimeout(r, 800));

                try {
                    await msg.reply({
                        file: PRIME_AUTO_REPLY_IMG,
                        message: PRIME_AUTO_REPLY_CAPTION,
                        parseMode: "html"
                    });
                    console.log(`[PRIME] ✅ Daily auto-reply sent to [${senderId}]! Locked until next midnight.`);
                } catch (e1) {
                    try {
                        await msg.reply({
                            message: PRIME_AUTO_REPLY_CAPTION,
                            parseMode: "html"
                        });
                    } catch (e2) {}
                }
            }
            // আজকের দিনের জন্য পুরোপুরি লক — ব্যবহারকারী সারাদিনে আর যাই লিখুক কোনো মেসেজ পাঠানো হবে না।
            return;
        } catch (err) {
            console.error(`[PRIME HANDLER ERROR]:`, err.message);
        }
    }, new NewMessage({ incoming: true }));
}

async function initPrimeAutoResponder() {
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) {
            for (const [ph, rec] of primeClients) {
                try { await rec.client.disconnect(); } catch (e) {}
            }
            primeClients.clear();
            primeClient = null;
            primePhone = null;
            return;
        }

        // যদি কোনো একাউন্টে isPrime: true করা থাকে তা নেবে
        // আর কোনো একাউন্টে Prime অন করা না থাকলেও স্বয়ংক্রিয়ভাবে প্রথম একটিভ একাউন্ট দিয়েই রিপ্লাই চালু রাখবে
        let primeDocs = snap.docs.filter(d => (d.data() || {}).isPrime === true);
        if (primeDocs.length === 0) {
            const firstActive = snap.docs.find(d => (d.data() || {}).active !== false && (d.data() || {}).session);
            if (firstActive) {
                primeDocs = [firstActive];
                console.log(`[PRIME] No prime explicitly set. Auto-selected [${firstActive.id}] as Prime responder.`);
            }
        }

        const wanted = new Map(); // phone -> { id, session }
        primeDocs.forEach(d => {
            const v = d.data() || {};
            const phone = v.phone || d.id;
            if (v.session) wanted.set(phone, { id: d.id, session: v.session, phone });
        });

        // আর prime নেই এমন client disconnect করো
        for (const [ph, rec] of primeClients) {
            if (!wanted.has(ph)) {
                try { await rec.client.disconnect(); } catch (e) {}
                primeClients.delete(ph);
                console.log(`[PRIME] Disconnected removed prime: ${ph}`);
            }
        }

        // নতুন prime connect করো (already connected skip)
        for (const [phone, info] of wanted) {
            if (primeClients.has(phone)) continue;
            try {
                const client = new TelegramClient(new StringSession(info.session), DEFAULT_API_ID, DEFAULT_API_HASH, {
                    connectionRetries: 10,
                    autoReconnect: true
                });
                await client.connect();
                // ইভেন্ট লিসেনিং অন করতে সেশন সিঙ্ক করা
                await client.getDialogs({ limit: 1 }).catch(() => {});
                const me = await client.getMe().catch(() => null);
                attachPrimeHandler(client, phone);
                primeClients.set(phone, { client, connectedAt: Date.now(), docId: info.id });
                console.log(`[PRIME] Multi-prime online & listening: ${phone} (${me ? me.firstName : 'Active'}) [Total: ${primeClients.size}]`);
            } catch (e) {
                console.warn(`[PRIME] Connect failed ${phone}:`, (e && e.message) || e);
            }
        }

        // compat: প্রথমটাকে primeClient রাখো
        const first = primeClients.keys().next();
        if (!first.done) {
            primePhone = first.value;
            primeClient = primeClients.get(primePhone).client;
        } else {
            primeClient = null;
            primePhone = null;
        }
        if (wanted.size) console.log(`[PRIME] Pool status: ${primeClients.size}/${wanted.size} online`);
    } catch (e) {}
}

// রিয়েলটাইম রেস-কন্ডিশন ব্লক করার জন্য তাৎক্ষণিক মেমোরি লক
const instantReplyLock = new Set();

async function primeCooldownClaim(senderId) {
    // দিনে ঠিক ১ বার মাত্র অটো রিপ্লাই যাবে (সব অ্যাকাউন্ট মিলিয়ে গ্লোবাল লক)
    const today = dhakaDay(0);
    const key = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '');

    // ১. ইনস্ট্যান্ট মেমোরি লক (একই মিলিসেকেন্ডে একাধিক প্রাইম অ্যাকাউন্ট ব্লক করা)
    if (instantReplyLock.has(key)) return false;

    // ২. আজকের দিনের মেমোরি রেকর্ড চেক
    const mem = autoReplyCooldown.get(key);
    if (mem && mem === today) {
        return false;
    }

    // তৎক্ষণাৎ লক করা
    instantReplyLock.add(key);

    try {
        const ref = db.collection("tg_autoreply").doc(key);
        const snap = await ref.get();
        if (snap.exists) {
            const data = snap.data();
            if (data.day === today) {
                autoReplyCooldown.set(key, today);
                return false; // আজকের দিনে অলরেডি রিপ্লাই পেয়ে গেছে
            }
        }

        // আজকের জন্য পার্মানেন্ট লক করা
        autoReplyCooldown.set(key, today);
        setTimeout(() => instantReplyLock.delete(key), 15000); // ১৫ সেকেন্ড পর টেম্পোরারি লক রিলিজ
        await ref.set({
            day: today,
            senderId: senderId,
            lastAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return true;
    } catch (e) {
        if (mem && mem === today) return false;
        autoReplyCooldown.set(key, today);
        setTimeout(() => instantReplyLock.delete(key), 15000);
        return true;
    }
}

// Multi-prime live status (TelegramWorker থেকে দেখা যাবে)
app.get("/api/tg/prime-status", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").where("isPrime", "==", true).get();
        const wanted = [];
        snap.forEach(d => wanted.push(d.data().phone || d.id));
        const online = Array.from(primeClients.keys());
        return res.json({ ok: true, wanted, online, count: { wanted: wanted.length, online: online.length } });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. OFFICIAL WEB-LIKE SESSION GENERATOR ENGINE ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const rawInput = req.body.phone || "";
    const phone = formatBdPhone(rawInput);
    const chosenApiId = parseInt(req.body.apiId || DEFAULT_API_ID, 10);
    const chosenApiHash = (req.body.apiHash || DEFAULT_API_HASH).trim();

    console.log(`[SESSION GEN] Requesting Telegram Code for: ${phone} (API_ID: ${chosenApiId})`);

    if (!phone || phone.length < 13) {
        return res.status(400).json({ ok: false, error: "সঠিক মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    try {
        const client = new TelegramClient(new StringSession(""), chosenApiId, chosenApiHash, {
            connectionRetries: 5,
            useWSS: false,
            deviceModel: "Chrome Web 122",
            systemVersion: "Windows 11",
            appVersion: "1.0.0",
            langCode: "en",
            systemLangCode: "en"
        });

        await client.connect();

        const result = await client.sendCode({
            apiId: chosenApiId,
            apiHash: chosenApiHash
        }, phone);

        pendingAuthClients.set(phone, {
            client: client,
            apiId: chosenApiId,
            apiHash: chosenApiHash,
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        console.log(`[SESSION GEN] Code Sent Successfully to: ${phone}`);
        return res.json({ ok: true, message: "টেলিগ্রামে লগইন কোড পাঠানো হয়েছে!", phone });
    } catch (err) {
        console.error(`[SESSION GEN ERR]:`, err);
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "Failed to send code" });
    }
});

async function handleTelegram2FALogin(client, password) {
    // অফিশিয়াল GramJS 2FA Password হ্যান্ডলার
    if (typeof client.signInWithPassword === "function") {
        return await client.signInWithPassword({ password });
    }

    let computeFn = null;
    try {
        const pwdMod = require("telegram/Password");
        computeFn = pwdMod.computeCheckPassword || (pwdMod.default && pwdMod.default.computeCheckPassword) || pwdMod;
    } catch (e1) {
        try {
            const tlMod = require("telegram");
            computeFn = tlMod.computeCheckPassword || (tlMod.Password && tlMod.Password.computeCheckPassword);
        } catch (e2) {}
    }

    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    if (typeof computeFn === "function") {
        const passwordSrpHash = await computeFn(passwordInfo, password);
        return await client.invoke(new Api.auth.CheckPassword({ password: passwordSrpHash }));
    }

    // অল্টারনেটিভ চেক পাসওয়ার্ড কল
    if (typeof client.checkPassword === "function") {
        return await client.checkPassword(password);
    }
    throw new Error("টেলিগ্রাম 2FA পাসওয়ার্ড প্রসেস করা সম্ভব হয়নি");
}

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশনের মেয়াদ শেষ! আবার নম্বর দিন।" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            const errStr = (signInErr.errorMessage || signInErr.message || "").toUpperCase();
            if (errStr.includes("SESSION_PASSWORD_NEEDED") || errStr.includes("2FA") || errStr.includes("PASSWORD")) {
                if (!password) return res.status(400).json({ ok: false, error: "আপনার টেলিগ্রামে 2FA চালু আছে! পাসওয়ার্ডটি দিন।" });

                await handleTelegram2FALogin(item.client, password);
            } else {
                throw signInErr;
            }
        }

        const sessionString = item.client.session.save();
        console.log(`[SESSION CREATED] Generated Session for ${phone}`);

        const docId = phone.replace('+', '');
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

// ---------------- 7b. DIRECT SESSION CONNECT API ----------------
app.post("/api/tg/connect-session", async (req, res) => {
    const rawInput = req.body.phone || "";
    const phone = formatBdPhone(rawInput);
    const sessionString = (req.body.session || "").toString().trim();

    if (!phone || !sessionString) {
        return res.status(400).json({ ok: false, error: "ফোন নম্বর ও সেশন উভয়ই প্রয়োজন" });
    }

    try {
        // সেশনটি আসলেই কাজ করছে কিনা তাৎক্ষণিক টেস্ট
        const testClient = new TelegramClient(new StringSession(sessionString), DEFAULT_API_ID, DEFAULT_API_HASH, {
            connectionRetries: 3
        });
        await testClient.connect();
        const me = await testClient.getMe().catch(() => null);

        if (!me) {
            await testClient.disconnect();
            return res.status(400).json({ ok: false, error: "সেশনটি অবৈধ বা মেয়াদোত্তীর্ণ!" });
        }

        const docId = phone.replace('+', '');
        await db.collection("tg_accounts").doc(docId).set({
            phone,
            session: sessionString,
            balance: 0,
            active: true,
            isPrime: false, // ডিফল্টভাবে টাস্ক ওয়ার্কার হিসেবে যুক্ত হবে (প্রাইম শুধুমাত্র অটো-রিপ্লাইয়ের জন্য)
            firstName: me.firstName || "Telegram User",
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await testClient.disconnect();
        console.log(`[DIRECT SESSION CONNECTED] Successfully attached account ${phone} (${me.firstName})`);
        
        // তাৎক্ষণিক প্রাইম রেসপন্ডার রিলোড
        setTimeout(() => {
            initPrimeAutoResponder().catch(() => {});
        }, 1000);

        return res.json({ ok: true, message: "অ্যাকাউন্ট সফলভাবে কানেক্ট হয়েছে!", phone, name: me.firstName });
    } catch (err) {
        console.error("[DIRECT SESSION ERR]:", err);
        return res.status(500).json({ ok: false, error: err.message || "কানেক্ট ব্যর্থ হয়েছে" });
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
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

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

// ---------------- 8b. MASS PROMO & DAILY CLAIM ----------------
function normalizeGameStr(str) {
    return (str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // é -> e, è -> e ইত্যাদি রূপান্তর
        .toLowerCase()
        .replace(/\s*\(\d+\)|\s*\(all\)/gi, "") // (50), (All) পয়েন্ট ট্যাগ রিমুভ
        .replace(/[^a-z0-9]/g, " ")     // ™, |, (), ব্র্যাকেট সব স্পেস করে ফেলা
        .replace(/\s+/g, " ")
        .trim();
}

async function triggerButtonClick(message, button, client) {
    try {
        await message.click({ text: button.text });
        return true;
    } catch (e) {
        try {
            const activeClient = client || currentClient;
            if (activeClient) {
                await activeClient.sendMessage(TARGET_BOT, { message: button.text });
                return true;
            }
        } catch (e2) {}
    }
    return false;
}

async function clickChestButton(message, gameName, client = null) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return false;
    const cleanTarget = normalizeGameStr(gameName.replace(/\(.*?\)/g, "").replace(/\|\d+\|/g, "")).replace(/\s+/g, "");
    const targetWords = cleanTarget.split(" ").filter(w => w.length >= 2);

    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (!button.text) continue;
            const rawBtnText = button.text;
            const cleanBtn = normalizeGameStr(rawBtnText).replace(/\s+/g, "");

            // হুবহু বা পার্সিয়াল মিল চেক (স্পেস বা ব্র্যাকেট ছাড়াই)
            if (cleanBtn.includes(cleanTarget) || cleanTarget.includes(cleanBtn)) {
                console.log(`[CHEST CLICK] Matched button "${rawBtnText}" with target "${gameName}"`);
                return await triggerButtonClick(message, button, client);
            }

            const matchCount = targetWords.filter(w => cleanBtn.includes(w)).length;
            if (targetWords.length > 0 && matchCount >= Math.min(2, targetWords.length)) {
                return await triggerButtonClick(message, button, client);
            }
        }
    }

    if (targetWords.length > 0) {
        const primaryKeyword = targetWords[0];
        for (const row of message.replyMarkup.rows) {
            for (const button of row.buttons) {
                if (!button.text) continue;
                const cleanBtn = normalizeGameStr(button.text);
                if (cleanBtn.includes(primaryKeyword)) {
                    return await triggerButtonClick(message, button, client);
                }
            }
        }
    }
    return false;
}

async function clickInlineButton(message, textPattern, client = null) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return false;
    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (button.text && button.text.toLowerCase().includes(textPattern.toLowerCase())) {
                try {
                    await message.click({ text: button.text });
                    return true;
                } catch (e) {
                    try {
                        const activeClient = client || currentClient;
                        if (activeClient) {
                            await activeClient.sendMessage(TARGET_BOT, { message: button.text });
                            return true;
                        }
                    } catch (e2) {}
                }
            }
        }
    }
    return false;
}

app.post("/api/tg/claim-daily-all", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            const temp = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
            try {
                await temp.connect();
                await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
                await new Promise((r) => setTimeout(r, 2200));
                const msgs = await temp.getMessages(TARGET_BOT, { limit: 2 });
                const targetMsg = (msgs && msgs.length > 0) ? (msgs.find(m => !m.out) || msgs[0]) : null;

                if (targetMsg) {
                    // বটের বাটনে Claim, Daily Streak, Claim Today ইত্যাদির সাপোর্ট
                    let clicked = await clickInlineButton(targetMsg, "Claim Today");
                    if (!clicked) clicked = await clickInlineButton(targetMsg, "Claim");
                    if (!clicked) clicked = await clickInlineButton(targetMsg, "Daily");

                    const msgTxt = (targetMsg.message || "").toLowerCase();
                    if (clicked) {
                        results.push({ phone, ok: true, message: "Daily Reward Claimed! 🎁" });
                    } else if (msgTxt.includes("claimed") || msgTxt.includes("left")) {
                        results.push({ phone, ok: true, message: "Already Claimed Today (Streak Active)" });
                    } else {
                        results.push({ phone, ok: false, message: "Could not claim or button not active" });
                    }
                }
            } catch (e) {
                results.push({ phone, ok: false, message: e.message });
            } finally {
                try { await temp.disconnect(); } catch (e) {}
            }
            await new Promise((r) => setTimeout(r, 1500));
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/redeem-code-all", async (req, res) => {
    const code = (req.body.code || "").toString().trim();
    if (!code) return res.status(400).json({ ok: false, error: "প্রোমো কোডটি দিন" });

    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            const temp = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
            try {
                await temp.connect();
                await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
                await new Promise((r) => setTimeout(r, 2000));
                const msgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
                if (msgs && msgs.length > 0) {
                    await clickInlineButton(msgs[0], "Redeem Promo");
                    await new Promise((r) => setTimeout(r, 2000));
                    await temp.sendMessage(TARGET_BOT, { message: code });
                    results.push({ phone, ok: true, message: "Promo Sent!" });
                }
            } catch (e) {
                results.push({ phone, ok: false, message: e.message });
            } finally {
                try { await temp.disconnect(); } catch (e) {}
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 10. USER NOTIFY HELPER (@Ppmod_bot) ----------------
function maskGmail(email) {
    const e = (email || "").toString().trim();
    const at = e.lastIndexOf("@");
    if (at <= 1) return e ? "++++++" : "—";
    return "++++++" + e.slice(at - 3, at) + e.slice(at);
}
async function sendOrderLog(text, buttonUrl = "https://ppmods.netlify.app/", buttonText = "🌐 Visit Website (টাস্ক শুরু করুন)") {
    if (!text) return;
    try {
        await fetch(`https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: ORDER_LOG_CHANNEL,
                text: text,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: buttonText, url: buttonUrl }]
                    ]
                }
            })
        });
    } catch (e) {
        console.error("[sendOrderLog error]:", e.message);
    }
}

let isAutoFakeLogEnabled = true;

// ডাটাবেজ থেকে অটো-লগের অবস্থা চেক
(async () => {
    try {
        const cSnap = await db.collection("config").doc("app").get();
        if (cSnap.exists && cSnap.data().autoFakeLog !== undefined) {
            isAutoFakeLogEnabled = cSnap.data().autoFakeLog;
        }
    } catch (e) {}
})();

const POPULAR_GAMES_LOG = [
    "8ball pool (50)", "Angry birds 2 (50)", "Best Fiends (50)", "Dice dreams (50)",
    "Domino dreams (50)", "Farm heroes (50)", "Hey day (All)", "Lords mobile (50)",
    "Mobile legends (50)", "Summoners War (50)", "Fruit ninja (50)", "Zenless Zone Zero (50)",
    "War machines (50)", "Yalla Ludo (50)"
];
const EMAIL_SNIPPETS = ["has", "rak", "tan", "784", "902", "sh", "joy", "fah", "321", "nah", "kab", "551", "al", "sak", "619", "mim"];

function generateRealisticFakeLog() {
    const game = POPULAR_GAMES_LOG[Math.floor(Math.random() * POPULAR_GAMES_LOG.length)];
    const snip = EMAIL_SNIPPETS[Math.floor(Math.random() * EMAIL_SNIPPETS.length)];
    const maskedEmail = `++++++${snip}@gmail.com`;
    const elapsed = Math.floor(Math.random() * 6) + 6;
    const trxId = "WLT-" + Math.random().toString(36).substring(2, 9).toUpperCase();

    return `✅ <b>TASK COMPLETED</b>\n\n` +
           `🎮 <b>Game:</b> ${game}\n` +
           `📧 <b>Gmail:</b> <code>${maskedEmail}</code>\n` +
           `⏱️ <b>Time:</b> ~${elapsed}s\n` +
           `🪙 <b>Coins:</b> 3\n` +
           `💳 <b>Method:</b> PP Coins\n` +
           `🔖 <b>TrxID:</b> <code>${trxId}</code>\n` +
           `📌 <b>Status:</b> Completed`;
}

function scheduleNextFakeOrderLog() {
    const randomMinutes = Math.floor(Math.random() * (25 - 8 + 1)) + 8;
    const delayMs = randomMinutes * 60 * 1000;
    setTimeout(async () => {
        try {
            if (isAutoFakeLogEnabled) {
                const fakeLog = generateRealisticFakeLog();
                await sendOrderLog(fakeLog);
            }
        } catch (e) {}
        scheduleNextFakeOrderLog();
    }, delayMs);
}

async function getUserTgId(uid, fallback) {
    try {
        if (uid) {
            const uSnap = await db.collection("users").doc(uid).get();
            if (uSnap.exists) {
                const t = (uSnap.data().tgChatId || "").toString().trim();
                if (t) return t;
            }
        }
    } catch (e) {}
    return fallback || "";
}

async function notifyUserTelegram(chatId, text) {
    if (!chatId) return;
    try {
        const cleanChatId = chatId.toString().replace(/[^0-9]/g, "");
        if (cleanChatId.length >= 5) {
            const url = `https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`;
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: cleanChatId, text: text, parse_mode: "HTML" })
            });
        }
    } catch (e) {}
}

function extractPromptNumber(text) {
    if (!text) return null;
    // শুধুমাত্র গুগল সিকিউরিটি ট্যাপ নম্বর সংক্রান্ত মেসেজ আসলেই প্রম্পট নম্বর ডিটেক্ট করবে
    const match = text.match(/(?:tap\s*number|tap|select|press|code|number)\s*[:\-]?\s*(\d{1,2})\b/i)
               || text.match(/(?:notification to your phone.*?)\b(\d{1,2})\b/i);
    return match ? match[1] : null;
}

function extractDeviceModel(text) {
    if (!text) return "";
    const m = text.match(/phone\s*\(([^)]+)\)/i);
    return m ? m[1].trim() : "";
}

function extractBotElapsedTime(text) {
    if (!text) return null;
    const m = text.match(/(?:time\s*elapsed|elapsed|time|completed\s*in|took)\s*[:\-~=\s]*~?\s*([\d.]+)\s*(?:s|sec|seconds)?/i)
           || text.match(/⏱️\s*~?\s*([\d.]+)\s*(?:s|sec)?/i);
    return m ? Math.round(parseFloat(m[1])) : null;
}

function sanitizeBotReason(rawText) {
    if (!rawText) return null;
    const txt = rawText.toLowerCase();

    // সেফগার্ড: মেসেজে যদি গুগল প্রম্পট, ফোন অনুমোদন বা কাজ শেষের টেক্সট থাকে, তবে কখনোই এরর ধরবে না
    if (txt.includes("tap") || txt.includes("notification to your phone") || txt.includes("confirmed from your phone") || 
        txt.includes("unlocking task") || txt.includes("all quests") || txt.includes("completed") || txt.includes("claim your points")) {
        return null;
    }

    // ১. ভুল জিমেইল বা গুগল একাউন্ট না পাওয়ার সব এরর হ্যান্ডলার
    if (txt.includes("couldn't find your google account") || txt.includes("could not find your google account") ||
        txt.includes("find your google account") || txt.includes("no account found") || 
        txt.includes("account does not exist") || txt.includes("invalid email") || 
        txt.includes("wrong email") || txt.includes("email not found") || 
        txt.includes("enter a valid email") || txt.includes("doesn't match our records")) {
        return "📧 <b>জিমেইল ভুল / পাওয়া যায়নি!</b>\n\nগুগলে এই জিমেইল অ্যাড্রেসটি পাওয়া যায়নি। অনুগ্রহ করে সঠিক জিমেইল দিয়ে পুনরায় চেষ্টা করুন।";
    }

    if (txt.includes("format:") || txt.includes("invalid format") || txt.includes("send format")) {
        return "⚠️ <b>ফরম্যাট ত্রুটি!</b>\n\nইমেইল বা পাসওয়ার্ডের ফরম্যাট বটের কাছে পৌঁছায়নি। অনুগ্রহ করে পুনরায় সঠিক তথ্য সাবমিট করুন।";
    }

    // শুধুমাত্র খাঁটি অথেন্টিকেটর কি চাচ্ছে কিনা চেক (কোনো সাধারণ সংখ্যা 32/34 এর সাথে মিলবে না)
    if (txt.includes("authenticator app") || txt.includes("totp key") || txt.includes("2fa secret key") || txt.includes("enter 32-character")) {
        return "🔑 <b>জিমেইলে অথেন্টিকেটর অ্যাপ সিকিউরিটি চালু আছে!</b>\n\nলগইন সম্পন্ন করতে সাময়িকভাবে Authenticator 2FA বন্ধ করে আবার সাবমিট করুন।";
    }

    if (txt.includes("password error") || txt.includes("incorrect password") || txt.includes("wrong password") || txt.includes("invalid password") || txt.includes("bad password")) {
        return "🔑 <b>জিমেইল পাসওয়ার্ড ভুল হয়েছে!</b>\n\nআপনার দেওয়া পাসওয়ার্ড দিয়ে গুগলে লগইন করা যাচ্ছে না। দয়া করে সঠিক পাসওয়ার্ড দিয়ে পুনরায় সাবমিট করুন।";
    }

    if (txt.includes("play games profile") || txt.includes("gamer tag") || txt.includes("profile not created") || txt.includes("open play games")) {
        return "🎮 <b>Play Games প্রোফাইল তৈরি করা নেই!</b>\n\nআপনার এই জিমেইলে এখনও Google Play Games প্রোফাইল সেটআপ করা হয়নি।\n💡 <b>করণীয়:</b> আপনার ফোনের Play Games অ্যাপটি ওপেন করে একটি গেমার ট্যাগ/নাম সিলেক্ট করে প্রোফাইল বানিয়ে তারপর আবার সাবমিট করুন।";
    }

    if (txt.includes("no quests") || txt.includes("quest not started") || txt.includes("not enrolled") || txt.includes("already completed")) {
        return "⚠️ <b>Play Points কোয়েস্ট পাওয়া যায়নি!</b>\n\nএই জিমেইলে প্লে পয়েন্ট কোয়েস্ট চালু/accept করা নেই অথবা আগেই পয়েন্ট নেওয়া হয়ে গেছে। অন্য ফ্রেশ জিমেইল দিয়ে চেষ্টা করুন।";
    }

    if (txt.includes("captcha security check") || txt.includes("captcha")) {
        return "🤖 <b>গুগল সিকিউরিটি ক্যাপচা!</b>\n\nগুগল স্বয়ংক্রিয় লগইনে অতিরিক্ত ভেরিফিকেশন চাচ্ছে। ৫-১০ মিনিট পর পুনরায় চেষ্টা করুন।";
    }

    if (txt.includes("google rejected") || txt.includes("couldn't sign you in") || txt.includes("disabled") || txt.includes("suspended")) {
        return "🚫 <b>গুগল লগইন প্রত্যাখ্যান করেছে!</b>\n\nজিমেইলের কান্ট্রি সাপোর্ট করছে না অথবা লগইন রিজেক্ট হয়েছে। অন্য একটি সচল জিমেইল ব্যবহার করুন।";
    }

    if (txt.includes("security code") || txt.includes("8-digit") || txt.includes("backup code")) {
        return "🔐 <b>অতিরিক্ত টু-স্টেপ সিকিউরিটি কোড প্রয়োজন!</b>\n\nগুগল ব্যাকআপ সিকিউরিটি কোড চাচ্ছে। ঝামেলামুক্ত কাজের জন্য সাময়িকভাবে 2FA বন্ধ করে আবার সাবমিট করুন।";
    }

    return null;
}

function extractGamerName(text) {
    if (!text) return "";
    const pats = [
        /google\s*play\s*gamer\s*[:\-]?\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /play\s*gamer\s*[:\-]?\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bgamer\s*(?:name)?\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bplayer\s*(?:name)?\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bnickname\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i
    ];
    for (const p of pats) {
        const m = text.match(p);
        if (m && m[1]) {
            const v = m[1].trim().replace(/\s+/g, " ").slice(0, 40);
            if (v && !/^(account|gmail|email|none|n\/a|null)$/i.test(v)) return v;
        }
    }
    return "";
}

async function getLatestBotMessage(client = null, minTimestamp = 0) {
    try {
        const activeClient = client || currentClient;
        if (!activeClient) return null;
        const msgs = await activeClient.getMessages(TARGET_BOT, { limit: 4 });
        if (msgs && msgs.length > 0) {
            const incoming = msgs.filter(m => !m.out);
            // সার্ভার ও টেলিগ্রাম ক্লকের সামান্য পার্থক্য যাতে মেসেজ বাদ না ফেলে (-15s tolerance)
            const fresh = minTimestamp > 0 
                ? incoming.filter(m => (m.date * 1000) >= (minTimestamp - 15000))
                : incoming;

            if (fresh.length > 0) {
                const newest = fresh[0];
                newest._combinedText = newest.message || "";
                return newest;
            }
        }
    } catch (e) {}
    return null;
}

async function waitForCondition(checkFn, timeoutMs = 45000, client = null) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const msg = await getLatestBotMessage(client || currentClient);
        if (msg) {
            const res = checkFn(msg);
            if (res) return { msg, res };
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
}

const connectedWorkerPool = new Map();

// ফ্রি এবং সেশন থাকা যেকোনো সচল ক্লায়েন্ট খোঁজা (Prime হোক বা নরমাল, সব অ্যাকাউন্টই সমান্তরালভাবে টাস্ক সম্পন্ন করবে)
async function getAvailableWorkerClient() {
    const snap = await db.collection("tg_accounts").where("active", "==", true).get();
    const accounts = [];
    snap.forEach((d) => accounts.push({ id: d.id, ...d.data() }));

    // সব সচল অ্যাকাউন্টই টাস্ক ওয়ার্কার
    const workerAccounts = accounts.filter(a => a.session && a.active !== false);

    // যে অ্যাকাউন্ট এখন busy নয় এবং সেশন একটিভ আছে
    const freeAccount = workerAccounts
        .filter(a => !busyWorkers.has(a.phone || a.id))
        .sort((a, b) => (Number(b.balance || 0)) - (Number(a.balance || 0)))[0];

    if (!freeAccount) {
        return null; // সব অ্যাকাউন্ট এখন ব্যস্ত!
    }

    const chosenPhone = freeAccount.phone || freeAccount.id;

    // ১. প্রাইম ক্লায়েন্টদের মধ্যে অলরেডি সচল থাকলে কানেকশন রিইউজ
    if (typeof primeClients !== "undefined" && primeClients.has(chosenPhone)) {
        const pRec = primeClients.get(chosenPhone);
        if (pRec && pRec.client && pRec.client.connected) {
            return { client: pRec.client, phone: chosenPhone, docId: freeAccount.id };
        }
    }

    // ২. ওয়ার্কার পুলে অলরেডি সচল থাকলে কানেকশন রিইউজ (বিদ্যুৎ গতি)
    if (connectedWorkerPool.has(chosenPhone)) {
        const poolClient = connectedWorkerPool.get(chosenPhone);
        if (poolClient && poolClient.connected) {
            return { client: poolClient, phone: chosenPhone, docId: freeAccount.id };
        }
    }

    // ৩. নতুন সেশন কানেক্ট করা ও পুলে সংরক্ষণ করা
    const client = new TelegramClient(new StringSession(freeAccount.session), DEFAULT_API_ID, DEFAULT_API_HASH, {
        connectionRetries: 5,
        autoReconnect: true
    });
    await client.connect();
    connectedWorkerPool.set(chosenPhone, client);
    return { client, phone: chosenPhone, docId: freeAccount.id };
}

// কমপ্যাটিবিলিটি ব্যাকওয়ার্ড কল
async function getUsableTelegramClient() {
    const res = await getAvailableWorkerClient();
    if (res) return res.client;
    throw new Error("ALL_WORKERS_BUSY");
}

async function refundOrder(orderId, uid, reason, userTgId = null) {
    if (completedOrdersTracker.has(orderId)) {
        console.warn(`[REFUND BLOCKED]: Order ${orderId} is completed. Refund strictly prohibited.`);
        return;
    }
    let refundAmt = 3;
    let refundHappened = false;
    try {
        await db.runTransaction(async (t) => {
            const ordRef = db.collection("orders").doc(orderId);
            const userRef = db.collection("users").doc(uid);
            const ordSnap = await t.get(ordRef);
            if (!ordSnap.exists) return;
            const ordData = ordSnap.data();
            if (ordData.status === "completed" || ordData.status === "refunded") return;

            const userSnap = await t.get(userRef);
            const ud = userSnap.exists ? userSnap.data() : {};
            const curReal = Number(ud.realBalance !== undefined ? ud.realBalance : (ud.balance || 0));
            const curBonus = Number(ud.bonusBalance || 0);

            refundAmt = Number(ordData.amount || 3);
            const refundReal = Number(ordData.paidWithReal !== undefined ? ordData.paidWithReal : refundAmt);
            const refundBonus = Number(ordData.paidWithBonus || 0);

            const newReal = Math.round((curReal + refundReal + Number.EPSILON) * 100) / 100;
            const newBonus = Math.round((curBonus + refundBonus + Number.EPSILON) * 100) / 100;
            const newTotal = Math.round((newReal + newBonus + Number.EPSILON) * 100) / 100;

            t.update(userRef, {
                realBalance: newReal,
                bonusBalance: newBonus,
                balance: newTotal
            });
            t.update(ordRef, {
                status: "refunded",
                adminMsg: `${reason}\n\n🪙 <b>আপনার ${refundAmt} PP Coins ওয়ালেটে রিফান্ড করা হয়েছে।</b>`,
                refundedAt: admin.firestore.FieldValue.serverTimestamp(),
                botProcessing: false
            });
            refundHappened = true;
        });

        // শুধুমাত্র ফায়ারস্টোর যদি আসলেই রিফান্ড করে, কেবল তখনই D1-এ ক্রেডিট করা
        if (refundHappened) {
            try {
                await cfFetch(`${CF_API}/api/wallet/credit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uid: uid, coins: refundAmt, type: "real" })
                });
                await cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        orderId: orderId,
                        status: "refunded",
                        adminMsg: `${reason}\n\n🪙 আপনার ${refundAmt} PP Coins ওয়ালেটে রিফান্ড করা হয়েছে।`
                    })
                });
            } catch (cfErr) {}
        }

        if (userTgId) {
            const notifyId = await getUserTgId(uid, userTgId);
            await notifyUserTelegram(notifyId,
                `❌ <b>অর্ডার রিফান্ড নোটিফিকেশন:</b>\n\n` +
                `🎮 <b>গেম:</b> ${orderData.game || 'Task'}\n` +
                `⚠️ <b>কারণ:</b> <i>${reason}</i>\n` +
                `🪙 <b>রিফান্ড:</b> ${refundAmt} টি PP Coins ওয়ালেটে ফেরত দেওয়া হয়েছে। ✅`
            );
        }
        // ক্যানসেল বা রিফান্ডে চ্যানেলে আর কোনো লগ পাঠানো হবে না (Only completed logs allowed)
    } catch (e) {}
}

async function processOrder(orderId, orderData, preAssignedWorker = null) {
    if (activeOrders.has(orderId)) return;
    activeOrders.add(orderId);

    const startTime = Date.now();
    const orderRef = db.collection("orders").doc(orderId);
    let assignedWorker = null;

    // Cloudflare D1-এ লাইভ স্ট্যাটাস আপডেট হেল্পার (ইউজার অ্যাপ ০ রিডে দেখতে পাবে)
    const syncCf = async (payload) => {
        try {
            await cfFetch(`${CF_API}/api/orders/update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId, ...payload })
            });
        } catch (e) {}
    };

    try {
        // ১. ফ্রি ওয়ার্কার খোঁজা
        let workerClientObj = preAssignedWorker || await getAvailableWorkerClient();

        // যদি সব ওয়ার্কার ব্যস্ত থাকে -> অর্ডারে কিউ স্ট্যাটাস সেট করা (রিফান্ড হবে না)
        if (!workerClientObj) {
            console.log(`[QUEUE] All workers busy. Holding order ${orderId} in fair queue.`);
            activeOrders.delete(orderId);
            await updateQueuePositions();
            return;
        }

        assignedWorker = workerClientObj.phone;
        busyWorkers.add(assignedWorker);
        const tg = workerClientObj.client;
        currentClient = tg;

        console.log(`[DISPATCH] Assigned order ${orderId} to worker [${assignedWorker}]`);
        syncCf({ adminMsg: "সার্ভার কাজ শুরু করেছে। লাইভ থাকুন...", status: "processing" });
        await orderRef.update({
            adminMsg: "সার্ভার কাজ শুরু করেছে। লাইভ থাকুন...",
            botProcessing: true,
            inQueue: false,
            queuePosition: 0,
            assignedWorker: assignedWorker
        }).catch(() => {});

        await tg.sendMessage(TARGET_BOT, { message: "/start" }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));

        // নতুন বট মেনু অনুযায়ী '📍 Select Quest' বাটন ক্লিক বা টেক্সট পাঠানো
        let initialMsg = await getLatestBotMessage(tg);
        let btnClicked = false;
        if (initialMsg) {
            btnClicked = await clickInlineButton(initialMsg, "Select Quest", tg);
            if (!btnClicked) btnClicked = await clickInlineButton(initialMsg, "Quest", tg);
        }
        if (!btnClicked) {
            await tg.sendMessage(TARGET_BOT, { message: "📍 Select Quest" }).catch(() => {});
            await tg.sendMessage(TARGET_BOT, { message: "Select Quest" }).catch(() => {});
            await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" }).catch(() => {});
        }

        let found = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("available chests") || txt.includes("select the desired chest") || txt.includes("chests") || txt.includes("choose a chest") || txt.includes("select quest") || txt.includes("choose");
        }, 25000, tg);

        if (!found) {
            await tg.sendMessage(TARGET_BOT, { message: "📍 Select Quest" }).catch(() => {});
            await tg.sendMessage(TARGET_BOT, { message: "Select Quest" }).catch(() => {});
            found = await waitForCondition((m) => {
                const txt = (m.message || "").toLowerCase();
                return txt.includes("available chests") || txt.includes("select the desired chest") || txt.includes("chests") || txt.includes("choose a chest");
            }, 15000, tg);
        }
        if (!found) throw new Error("সার্ভার রেসপন্স টাইমআউট! সংযোগে বিঘ্ন ঘটেছে, পুনরায় চেষ্টা করুন।");

        let clicked = await clickChestButton(found.msg, orderData.game || "", tg);
        if (!clicked) {
            await new Promise((r) => setTimeout(r, 1500));
            const retryMenu = await getLatestBotMessage(tg);
            if (retryMenu) clicked = await clickChestButton(retryMenu, orderData.game || "", tg);
        }
        
        // গেম বাটনে ক্লিক না হলে কখনোই ইমেইল পাঠানো যাবে না!
        if (!clicked) {
            throw new Error(`Google Play বটের মেনু থেকে "${orderData.game}" সিলেক্ট করা যায়নি। দয়া করে অন্য কোনো গেম সিলেক্ট করুন।`);
        }

        console.log(`[BOT] Game button clicked successfully for ${orderData.game}. Waiting for credentials prompt...`);
        syncCf({ adminMsg: "গেম নির্বাচন সম্পন্ন। জিমেইল ইনপুট চাওয়া হচ্ছে..." });

        // গেম বাটনে ক্লিকের পর বট যতক্ষণ না ক্রেডেনশিয়াল চাইছে ততক্ষণ অপেক্ষা করা (Wait for prompt)
        let credPromptFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("send format") || txt.includes("email password") || txt.includes("last account") || txt.includes("new account") || txt.includes("confirm deducting") || txt.includes("previous") || txt.includes("send your");
        }, 20000, tg);

        let promptMsg = credPromptFound ? credPromptFound.msg : await getLatestBotMessage(tg);
        if (promptMsg && (promptMsg.message.includes("Last account") || promptMsg.message.includes("Confirm deducting") || promptMsg.message.includes("Previous"))) {
            await clickInlineButton(promptMsg, "New account", tg);
            await new Promise((r) => setTimeout(r, 2000));
        }

        // বটের আপডেট অনুযায়ী এক স্পেস দিয়ে ফরম্যাট: email password
        const credText = `${orderData.accEmail.trim()} ${orderData.accPass.trim()}`;
        console.log(`[BOT SEND] Sending credentials for Order ${orderId}: ${maskGmail(orderData.accEmail)}`);
        const credSentTime = Date.now();
        
        await orderRef.update({ adminMsg: "জিমেইল ও পাসওয়ার্ড ক্লাউড সার্ভারে পাঠানো হচ্ছে..." });
        await tg.sendMessage(TARGET_BOT, { message: credText });

        let confirmFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("confirm credentials") || txt.includes("confirm and start") || txt.includes("confirm & pay") || txt.includes("confirm deducting") || txt.includes("confirm");
        }, 20000, tg);

        if (confirmFound) {
            let confClicked = await clickInlineButton(confirmFound.msg, "Confirm & Pay", tg);
            if (!confClicked) confClicked = await clickInlineButton(confirmFound.msg, "Confirm & Start", tg);
            if (!confClicked) confClicked = await clickInlineButton(confirmFound.msg, "Confirm credentials", tg);
            if (!confClicked) await clickInlineButton(confirmFound.msg, "Confirm", tg);
        }
        const loginInitMsg = "🔑 জিমেইল ও পাসওয়ার্ড ক্লাউড সার্ভারে যাচাই করা হচ্ছে...";
        syncCf({ adminMsg: loginInitMsg });
        await orderRef.update({ adminMsg: loginInitMsg });

        let completed = false;
        let attempts = 0;
        let gamerSaved = !!(orderData.gamerName);
        let gamerName = (orderData.gamerName || "").toString();
        let lastNotifiedPrompt = "";
        let hasPassedPasswordStage = false; // গুগল প্রম্পট বা ফোন লগইন স্টেজ পার হলে ট্রু হবে

        while (!completed && attempts < 50) {
            attempts++;
            await new Promise((r) => setTimeout(r, 2000));
            const curMsg = await getLatestBotMessage(tg, credSentTime);
            if (!curMsg) continue;

            const rawText = (curMsg._combinedText || curMsg.message || "").trim();
            const text = rawText.toLowerCase();

            if (!gamerSaved) {
                const g = extractGamerName(rawText);
                if (g) {
                    gamerSaved = true;
                    gamerName = g;
                    try { await orderRef.update({ gamerName: g }); } catch (e) {}
                }
            }

            // ১. সবার আগে চেক: কাজ কি সম্পন্ন হয়েছে? (সবার আগে সাফল্য নিশ্চিত করা)
            if (isBotTaskCompleted(rawText)) {
                completed = true;
                completedOrdersTracker.add(orderId);
                const botReportedTime = extractBotElapsedTime(rawText);
                const elapsedSec = botReportedTime !== null ? botReportedTime : Math.round((Date.now() - startTime) / 1000);

                syncCf({
                    status: "completed",
                    adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                    promptNumber: null,
                    timeElapsed: elapsedSec
                });

                await orderRef.update({
                    status: "completed",
                    adminMsg: `অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉`,
                    promptNumber: admin.firestore.FieldValue.delete(),
                    timeElapsed: elapsedSec,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false,
                    inQueue: false
                }).catch(() => {});

                if (orderData.userTgId || orderData.uid) {
                    const notifyId = await getUserTgId(orderData.uid, orderData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${orderData.game}\n` +
                        `⏱️ <b>সময় লেগেছে:</b> ~${elapsedSec} সেকেন্ড\n` +
                        `🪙 <b>ফি:</b> ৩টি PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    );
                }

                // ১. রিয়েল ব্যালেন্স দিয়ে করা হলে Cloudflare D1 ওয়ালেটে সাথে সাথে স্টার (+1 Star) যোগ করা
                const paidWithReal = Number(orderData.paidWithReal !== undefined ? orderData.paidWithReal : (orderData.amount || 3));
                const isRealTask = !orderData.isFreeTask && paidWithReal > 0;

                if (orderData.uid && orderData.uid !== 'guest' && isRealTask) {
                    cfFetch(`${CF_API}/api/wallet/credit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ uid: orderData.uid, loyaltyStarsInc: 1 })
                    }).catch(() => {});

                    try {
                        await db.collection("users").doc(orderData.uid).update({
                            loyaltyStars: admin.firestore.FieldValue.increment(1)
                        });
                    } catch (sErr) {}
                }

                try { await creditReferralBonus(orderData.uid, orderId, orderData.game); } catch (e) {}

                // ২. সম্পূর্ণ ডেটাসহ সরাসরি অ্যাডমিনের টেলিগ্রামে ইনস্ট্যান্ট নোটিফিকেশন পাঠানো
                const adminTgChatId = process.env.ADMIN_TG_ID || "7504616242";
                const adminAlertText = 
                    `🎉 <b>QUEST COMPLETED ALERT!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 <b>User:</b> ${orderData.name || "User"} (${orderData.email || "No Email"})\n` +
                    `🆔 <b>UID:</b> <code>${orderData.uid || "—"}</code>\n` +
                    `🎮 <b>Game:</b> ${orderData.game || "Task"}\n` +
                    `🕹️ <b>Gamer Tag:</b> ${(gamerName || "").trim() || "—"}\n` +
                    `📧 <b>Gmail:</b> <code>${orderData.accEmail}</code>\n` +
                    `🔑 <b>Pass:</b> <code>${orderData.accPass || "—"}</code>\n` +
                    `✈️ <b>User TG:</b> ${orderData.userTgId || "Not Given"}\n` +
                    `⏱️ <b>Time Elapsed:</b> ~${elapsedSec}s\n` +
                    `🪙 <b>Fee:</b> ${orderData.amount || 3} Coins ${isRealTask ? '(⭐ +1 Star Added)' : ''}\n` +
                    `🔖 <b>Order ID:</b> <code>${orderId}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ <i>Status: Completed on Worker [${assignedWorker || 'Bot'}]</i>`;

                userNotifyBot.sendMessage(adminTgChatId, adminAlertText, { parse_mode: "HTML" }).catch(() => {});

                // ৩. চ্যানেলে পাবলিক লগ পাঠানো
                sendOrderLog(
                    `✅ <b>TASK COMPLETED</b>\n\n` +
                    `🎮 <b>Game:</b> ${orderData.game || "Task"}\n` +
                    `📧 <b>Gmail:</b> <code>${maskGmail(orderData.accEmail)}</code>\n` +
                    `🎮 <b>Play Gamer:</b> ${(gamerName || "").trim() || "—"}\n` +
                    `⏱️ <b>Time:</b> ~${elapsedSec}s\n` +
                    `🪙 <b>Coins:</b> ${orderData.amount || 3}\n` +
                    `💳 <b>Method:</b> PP Coins\n` +
                    `🔖 <b>TrxID:</b> <code>${orderData.trxId || orderId}</code>\n` +
                    `📌 <b>Status:</b> Completed`
                );
                completed = true;
                return;
            }

            // ২. ফোন থেকে গুগল লগইন অনুমোদন হয়েছে কিনা চেক
            if (text.includes("sign-in confirmed from your phone") || text.includes("unlocking task") || text.includes("login successful")) {
                hasPassedPasswordStage = true;
                const loginSuccessMsg = "🎉 ফোন থেকে গুগল লগইন সফল হয়েছে! প্লে পয়েন্ট টাস্ক শুরু হচ্ছে, অপেক্ষা করুন...";
                syncCf({ adminMsg: loginSuccessMsg, promptNumber: null });
                await orderRef.update({
                    adminMsg: loginSuccessMsg,
                    promptNumber: admin.firestore.FieldValue.delete()
                }).catch(() => {});
            }

            // ৩. গুগল সিকিউরিটি ট্যাপ প্রম্পট এসেছে কিনা চেক (প্রম্পট আসার অর্থই পাসওয়ার্ড সঠিক!)
            const isErrorState = text.includes("google rejected") || text.includes("couldn't sign you in");
            const promptNum = isErrorState ? null : extractPromptNumber(rawText);
            const devModel = extractDeviceModel(rawText);

            if (promptNum && promptNum !== lastNotifiedPrompt && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                hasPassedPasswordStage = true; // গুগল প্রম্পট দিয়েছে মানেই পাসওয়ার্ড ১০০% সঠিক!
                lastNotifiedPrompt = promptNum;
                const devText = devModel ? ` (${devModel})` : "";
                const promptMsg = `PROMPT_NUMBER:${promptNum}|DEVICE:${devModel}|⚠️ আপনার ফোনে${devText} Google সিকিউরিটি নোটিফিকেশন গেছে! স্ক্রিনে এই সংখ্যাটিতে ট্যাপ করে অনুমোদন দিন:`;
                syncCf({ adminMsg: promptMsg, promptNumber: promptNum });
                await orderRef.update({ adminMsg: promptMsg, promptNumber: promptNum }).catch(() => {});
            }

            // ৪. এরর ফিল্টার: একবার পাসওয়ার্ড পার হয়ে প্রম্পট স্টেজে চলে গেলে বা লগইন হলে কখনোই পাসওয়ার্ড ভুল ধরা যাবে না!
            if (!hasPassedPasswordStage) {
                const cleanReason = sanitizeBotReason(rawText);
                if (cleanReason) {
                    await clickInlineButton(curMsg, "Cancel Process", tg);
                    await refundOrder(orderId, orderData.uid, cleanReason, orderData.userTgId);
                    return;
                }

                if (text.includes("password error") || text.includes("incorrect password") || text.includes("wrong password")) {
                    await clickInlineButton(curMsg, "Cancel Process", tg);
                    await refundOrder(orderId, orderData.uid, "🔑 ভুল পাসওয়ার্ড! সঠিক পাসওয়ার্ড দিয়ে আবার দিন।", orderData.userTgId);
                    return;
                }
            }

            // ৫. সাধারণ গুগল রিজেকশন বা ক্যাপচা এরর
            if (text.includes("captcha security check") || text.includes("captcha")) {
                await clickInlineButton(curMsg, "Cancel Process", tg);
                await refundOrder(orderId, orderData.uid, "Google Captcha সমস্যা দেখা দিয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            if (text.includes("google rejected sign-in") || text.includes("couldn't sign you in")) {
                await clickInlineButton(curMsg, "Cancel Process", tg);
                await refundOrder(orderId, orderData.uid, "Google অ্যাকাউন্ট লগইন রিজেক্ট করেছে (No চাপা হয়েছে বা ভেরিফিকেশন ফেইল)।", orderData.userTgId);
                return;
            }
        }
        if (!completed) {
            // রিফান্ড করার আগে শেষবারের মতো ফ্রেশ মেসেজে কমপ্লিট হয়েছে কিনা নিশ্চিত যাচাই
            const lastCheckMsg = await getLatestBotMessage(tg, 0);
            if (lastCheckMsg && isBotTaskCompleted(lastCheckMsg._combinedText || lastCheckMsg.message || "")) {
                completed = true;
                completedOrdersTracker.add(orderId);
                syncCf({
                    status: "completed",
                    adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                    promptNumber: null,
                    timeElapsed: Math.round((Date.now() - startTime) / 1000)
                });
                await orderRef.update({
                    status: "completed",
                    adminMsg: "অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉",
                    promptNumber: admin.firestore.FieldValue.delete(),
                    timeElapsed: Math.round((Date.now() - startTime) / 1000),
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false,
                    inQueue: false
                }).catch(() => {});
                return;
            }
            throw new Error("সার্ভার রেসপন্স সময়সীমা অতিক্রম করেছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।");
        }
    } catch (err) {
        let cleanErr = err.message || "সার্ভার সংযোগে সমস্যা হয়েছে।";
        if (cleanErr.includes("bot") || cleanErr.includes("timeout")) {
            cleanErr = "সার্ভারে লগইন ভেরিফিকেশন সম্পন্ন করা সম্ভব হয়নি। অনুগ্রহ করে আপনার জিমেইল তথ্য চেক করে পুনরায় চেষ্টা করুন।";
        }
        await refundOrder(orderId, orderData.uid, cleanErr, orderData.userTgId);
    } finally {
        activeOrders.delete(orderId);
        if (assignedWorker) {
            busyWorkers.delete(assignedWorker);
            console.log(`[WORKER RELEASED] Worker [${assignedWorker}] is now FREE.`);
        }
        // কিউতে থাকা পরবর্তী অর্ডারের প্রসেসিং কল
        setTimeout(() => {
            processNextQueueOrder();
        }, 800);
    }
}

// কিউ ক্যালকুলেটর ও পরবর্তী কাজ শুরুর মেকানিজম
async function updateQueuePositions() {
    try {
        const snap = await db.collection("orders")
            .where("status", "==", "pending")
            .orderBy("createdAt", "asc")
            .get();

        let pos = 1;
        for (const docSnap of snap.docs) {
            const ord = docSnap.data();
            // যে কাজগুলো অলরেডি প্রসেসিংয়ে চলছে সেগুলোকে বাদ দিয়ে কিউ কাউন্ট
            if (!activeOrders.has(docSnap.id) && ord.accEmail) {
                const estWaitSec = Math.max(15, pos * 25);
                const percentDone = Math.min(95, Math.max(10, Math.floor(100 - (pos * 15))));
                // ইউজারকে সিরিয়াল নম্বর না দেখিয়ে প্রফেশনাল ক্লাউড প্রসেসিং মেসেজ দেওয়া (সিরিয়াল ইন্টারনাল থাকবে)
                const msg = `⏳ ক্লাউড সার্ভারে আপনার রিকোয়েস্ট প্রসেসিং চলছে (${percentDone}% সম্পন্ন)। অনুগ্রহ করে পেজ কেটে বের হবেন না, লাইভ থাকুন...`;
                
                await docSnap.ref.update({
                    inQueue: true,
                    queuePosition: pos,
                    queuePercent: percentDone,
                    estimatedWaitSec: estWaitSec,
                    adminMsg: msg
                }).catch(() => {});

                // Cloudflare D1-এ লাইভ কিউ স্ট্যাটাস আপডেট
                try {
                    await cfFetch(`${CF_API}/api/orders/update`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            orderId: docSnap.id,
                            inQueue: true,
                            queuePosition: pos,
                            queuePercent: percentDone,
                            adminMsg: msg
                        })
                    });
                } catch (cfErr) {}

                pos++;
            }
        }
    } catch (e) {
        console.warn("[QUEUE SYNC ERR]:", e.message);
    }
}

async function processNextQueueOrder() {
    if (isQueueProcessing) return;
    isQueueProcessing = true;
    try {
        const snap = await db.collection("orders")
            .where("status", "==", "pending")
            .orderBy("createdAt", "asc")
            .limit(20)
            .get();

        for (const docSnap of snap.docs) {
            const ord = docSnap.data();
            if (ord.accEmail && ord.accPass && !activeOrders.has(docSnap.id)) {
                // একাধিক ওয়ার্কার ফ্রি থাকলে সমান্তরালভাবে প্যারালাল ডিসপ্যাচ হবে (কোনো break নেই)
                const workerObj = await getAvailableWorkerClient();
                if (!workerObj) {
                    // কোনো ফ্রি ওয়ার্কার এখন খালি নেই
                    break;
                }
                console.log(`[QUEUE DISPATCH] Assigned order ${docSnap.id} to worker [${workerObj.phone}]`);
                processOrder(docSnap.id, ord, workerObj);
            }
        }
        await updateQueuePositions();
    } catch (e) {
        console.error("[QUEUE DISPATCH ERR]:", e);
    }
    finally {
        isQueueProcessing = false;
    }
}

// ---------------- 13. MASTER WORKER START ----------------
let botModeCache;
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Master Guardian...");

    initPrimeAutoResponder().catch(() => {});
    let primeReinitTimer = null;
    db.collection("tg_accounts").onSnapshot(() => {
        if (primeReinitTimer) clearTimeout(primeReinitTimer);
        primeReinitTimer = setTimeout(() => {
            primeReinitTimer = null;
            initPrimeAutoResponder().catch(() => {});
        }, 3000);
    });

    scheduleNextFakeOrderLog();

    db.collection("config").doc("app").onSnapshot((snap) => {
        try {
            const d = snap.exists ? snap.data() : {};
            botModeCache = (d && d.botMode === undefined) ? undefined : !!(d && d.botMode);
            console.log("[CONFIG] botMode =", botModeCache);
        } catch (e) {}
    });

    getUsableTelegramClient().catch(() => {});

    async function claimDailySingle(sessionStr) {
        if (!sessionStr) return;
        const temp = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 3 });
        try {
            await temp.connect();
            await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
            await new Promise((r) => setTimeout(r, 2200));
            const msgs = await temp.getMessages(TARGET_BOT, { limit: 2 });
            const targetMsg = (msgs && msgs.length > 0) ? (msgs.find(m => !m.out) || msgs[0]) : null;
            if (targetMsg) {
                let clicked = await clickInlineButton(targetMsg, "Claim Today");
                if (!clicked) clicked = await clickInlineButton(targetMsg, "Claim");
                if (!clicked) clicked = await clickInlineButton(targetMsg, "Daily");
            }
        } finally {
            try { await temp.disconnect(); } catch (e) {}
        }
    }

    setInterval(async () => {
        try {
            const snap = await db.collection("tg_accounts").where("active", "==", true).get();
            for (const docSnap of snap.docs) {
                const acc = docSnap.data();
                if (acc.session) {
                    await claimDailySingle(acc.session).catch(() => {});
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
        } catch (e) {}
    }, 12 * 60 * 60 * 1000);

    const notifiedDeposits = new Set();
    db.collection("deposits").where("status", "==", "pending").onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const dep = change.doc.data();
                const depId = change.doc.id;
                if (notifiedDeposits.has(depId)) return;
                notifiedDeposits.add(depId);

                const adminAlert = 
                    `💰 <b>NEW DEPOSIT PENDING!</b>\n\n` +
                    `👤 <b>User:</b> ${dep.name || "User"} (${dep.email || "No Email"})\n` +
                    `💳 <b>Method:</b> ${dep.method}\n` +
                    `💵 <b>Amount:</b> ${dep.amount} BDT\n` +
                    `🪙 <b>Coins:</b> ${dep.coins || 3} Coins\n` +
                    `🔖 <b>TrxID:</b> <code>${dep.trxId}</code>\n` +
                    `🆔 <b>DepID:</b> <code>${depId}</code>\n\n` +
                    `👉 <i>এই মেসেজে রিপ্লাই দিয়ে <b>✅</b> পাঠালে Approve হবে।</i>\n` +
                    `👉 <i>এই মেসেজে রিপ্লাই দিয়ে <b>❌</b> পাঠালে Reject হবে।</i>`;

                userNotifyBot.sendMessage(process.env.ADMIN_TG_ID || "7504616242", adminAlert, { parse_mode: "HTML" }).catch(() => {});
            }
        });
    });

    // Realtime Pending Orders Listener & Instant Executive Telegram Alert
    const notifiedOrders = new Set();

    async function handleIncomingOrder(orderId, ord, source = "Firestore") {
        if (!ord || !ord.accEmail) return;
        if (ord.status !== "pending") return;
        if (completedOrdersTracker.has(orderId)) return;

        // ১. অ্যাডমিনের টেলিগ্রামে তাৎক্ষণিক ইন্টারেক্টিভ নোটিফিকেশন পাঠানো (Zero Delay)
        if (!notifiedOrders.has(orderId)) {
            notifiedOrders.add(orderId);
            try {
                let uName = ord.name;
                let uEmail = ord.email;
                if ((!uName || !uEmail || uName === 'User' || uEmail === 'No Email') && ord.uid) {
                    try {
                        const uSnap = await db.collection("users").doc(ord.uid).get();
                        if (uSnap.exists) {
                            const uData = uSnap.data() || {};
                            uName = uName || uData.name || uData.displayName || "User";
                            uEmail = uEmail || uData.email || "No Email";
                        }
                    } catch (e) {}
                }

                const adminChat = process.env.ADMIN_TG_ID || "7504616242";
                const workerObjCheck = await getAvailableWorkerClient();
                const workerStatusText = workerObjCheck 
                    ? `🤖 <b>Auto Bot Ready:</b> <code>[${workerObjCheck.phone}]</code>` 
                    : `⚠️ <b>No Worker Active:</b> <i>Admin manual action required</i>`;

                const alertText = 
                    `🚨 <b>NEW PP TASK ORDER!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🎮 <b>Game:</b> ${safeTgHtml(ord.game || 'Task')}\n` +
                    `👤 <b>User:</b> ${safeTgHtml(uName || 'User')} (${safeTgHtml(uEmail || 'No Email')})\n` +
                    `🆔 <b>UID:</b> <code>${ord.uid || '—'}</code>\n` +
                    `📧 <b>Gmail:</b> <code>${safeTgHtml(ord.accEmail)}</code>\n` +
                    `🔑 <b>Pass:</b> <code>${safeTgHtml(ord.accPass || '—')}</code>\n` +
                    `🕹️ <b>Play Gamer:</b> ${safeTgHtml(ord.gamerName || '—')}\n` +
                    `✈️ <b>User TG:</b> ${safeTgHtml(ord.userTgId || 'None')}\n` +
                    `🪙 <b>Amount:</b> ${ord.amount || 3} Coins\n` +
                    `🔖 <b>Order ID:</b> <code>${orderId}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${workerStatusText}\n` +
                    `⚡ <i>Action buttons below:</i>`;

                const orderKeyboard = {
                    inline_keyboard: [
                        [
                            { text: "✅ Complete Task", callback_data: `ord_complete:${orderId}` },
                            { text: "❌ Reject & Refund", callback_data: `ord_refund:${orderId}` }
                        ],
                        [
                            { text: "🔑 Request 2FA/Code", callback_data: `ord_ask_code:${orderId}` },
                            { text: "✉️ Send Message", callback_data: `ord_ask_msg:${orderId}` }
                        ],
                        [
                            { text: "👤 View User", callback_data: `u_view:${ord.uid}` },
                            { text: "🔄 Refresh", callback_data: `ord_refresh:${orderId}` }
                        ]
                    ]
                };

                await userNotifyBot.sendMessage(adminChat, alertText, {
                    parse_mode: "HTML",
                    reply_markup: orderKeyboard
                }).catch(e => console.warn("[Order Alert Err]:", e.message));
            } catch (e) {
                console.warn("[Order Alert Catch]:", e.message);
            }
        }

        // ২. যদি ওয়ার্কার অ্যাকাউন্ট খালি থাকে, অটোমেশন বট শুরু করা
        if (!activeOrders.has(orderId)) {
            const workerObj = await getAvailableWorkerClient();
            if (workerObj) {
                console.log(`[${source} ORDER] Starting execution for ${orderId} on worker [${workerObj.phone}]`);
                processOrder(orderId, ord, workerObj);
            } else {
                console.log(`[${source} ORDER] Order ${orderId} waiting in queue (no worker bot available).`);
                const queueMsg = "⏳ ক্লাউড সার্ভারে আপনার রিকোয়েস্টটি গৃহীত হয়েছে। এডমিন বা স্বয়ংক্রিয় বট শীঘ্রই প্রসেস করছে, লাইভ থাকুন...";
                cfFetch(`${CF_API}/api/orders/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderId, adminMsg: queueMsg, inQueue: true })
                }).catch(() => {});
                db.collection("orders").doc(orderId).update({
                    adminMsg: queueMsg,
                    inQueue: true
                }).catch(() => {});
            }
        }
    }

    // Realtime Pending Orders Listener — তাৎক্ষণিক বট এক্সিকিউশন শুরু করবে (Zero Delay)
    try {
        db.collection("orders").where("status", "==", "pending").onSnapshot((snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
                if (change.type === "added" || change.type === "modified") {
                    const ord = change.doc.data();
                    const orderId = change.doc.id;
                    handleIncomingOrder(orderId, ord, "Firestore Realtime");
                }
            });
        }, (err) => console.warn("[Worker] orders onSnapshot err:", err));
    } catch (e) {
        console.warn("[Worker] orders listener init err:", e);
    }

    // Cloudflare D1 Pending Order Checker
    setInterval(async () => {
        try {
            if (isQueueProcessing) return;
            const res = await cfFetch(`${CF_API}/api/orders/pending`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.ok && Array.isArray(data.orders)) {
                    for (const ord of data.orders) {
                        handleIncomingOrder(ord.id, ord, "Cloudflare D1");
                    }
                }
            }
        } catch (e) {}
    }, 3000);

    // ফায়ারবেসের ফলব্যাক চেক: কোটা বাঁচাতে প্রতি ৫ মিনিটে ব্যাকআপ চেক (অন-স্ন্যাপশট অলরেডি রিয়েলটাইমে কাজ করছে)
    setInterval(async () => {
        try {
            if (isQueueProcessing) return;
            const snap = await db.collection("orders").where("status", "==", "pending").limit(10).get();
            for (const doc of snap.docs) {
                const ord = doc.data();
                handleIncomingOrder(doc.id, ord, "Firestore Fallback");
            }
        } catch (e) {}
    }, 300000);

    console.log("[MASTER INIT] Active!");
}

startMasterWorker().catch(console.error);
