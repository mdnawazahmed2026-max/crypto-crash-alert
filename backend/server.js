const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MONITORED_COINS = [
    { symbol: 'BTC', binancePair: 'BTCUSDT' },
    { symbol: 'ETH', binancePair: 'ETHUSDT' },
    { symbol: 'SOL', bluePair: 'SOLUSDT' },
    { symbol: 'LINK', binancePair: 'LINKUSDT' },
    { symbol: 'POL', binancePair: 'POLUSDT' }
];

let memoryCache = {
    systemStatus: "Active",
    lastCheckTime: null,
    coins: {}
};

async function monitorMarket() {
    console.log(`[${new Date().toISOString()}] Checking prices...`);
    try {
        for (const coin of MONITORED_COINS) {
            let currentPrice = 0;
            try {
                const response = await axios.get(`https://binance.com{coin.binancePair}`);
                currentPrice = parseFloat(response.data.price);
            } catch (err) {
                console.error(`Binance API error for ${coin.symbol}:`, err.message);
                continue;
            }

            let { data: highRecord } = await supabase
                .from('historical_highs')
                .select('*')
                .eq('symbol', coin.symbol)
                .single();

            let rollingHigh = currentPrice;

            if (highRecord) {
                rollingHigh = parseFloat(highRecord.highest_price);
                if (currentPrice > rollingHigh) {
                    rollingHigh = currentPrice;
                    await supabase
                        .from('historical_highs')
                        .update({ highest_price: rollingHigh, updated_at: new Date() })
                        .eq('symbol', coin.symbol);
                }
            } else {
                await supabase
                    .from('historical_highs')
                    .insert([{ symbol: coin.symbol, highest_price: currentPrice }]);
            }

            const declinePercentage = ((rollingHigh - currentPrice) / rollingHigh) * 100;
            
            memoryCache.coins[coin.symbol] = {
                currentPrice,
                rollingHigh,
                declinePercentage: parseFloat(declinePercentage.toFixed(2))
            };

            if (declinePercentage >= 50.0) {
                const { data: existingAlert } = await supabase
                    .from('crash_events')
                    .select('*')
                    .eq('symbol', coin.symbol)
                    .eq('is_resolved', false);

                if (!existingAlert || existingAlert.length === 0) {
                    await supabase.from('crash_events').insert([{
                        symbol: coin.symbol,
                        crash_high: rollingHigh,
                        crash_price: currentPrice,
                        decline_percentage: declinePercentage
                    }]);

                    await sendTelegramNotification(coin.symbol, currentPrice, rollingHigh, declinePercentage);
                    await sendFirebaseNotification(coin.symbol, currentPrice, rollingHigh, declinePercentage);
                }
            } else {
                await supabase
                    .from('crash_events')
                    .update({ is_resolved: true })
                    .eq('symbol', coin.symbol)
                    .eq('is_resolved', false);
            }
        }
        memoryCache.lastCheckTime = new Date().toISOString();
    } catch (globalErr) {
        console.error("Loop error:", globalErr.message);
    }
}

async function sendTelegramNotification(symbol, price, high, decline) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const message = `🚨 *CRASH ALERT: ${symbol}* 🚨\n\n` +
                    `⚠️ Price dropped by *${decline.toFixed(2)}%*\n` +
                    `• Current Price: $${price}\n` +
                    `• 90-Day Peak: $${high}`;

    try {
        await axios.post(`https://telegram.org{token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Telegram error:", err.message);
    }
}

async function sendFirebaseNotification(symbol, price, high, decline) {
    const fcmServerKey = process.env.FCM_SERVER_KEY; 
    if (!fcmServerKey) return;

    const payload = {
        to: "/topics/crash_alerts",
        priority: "high",
        notification: {
            title: `CRASH ALERT: ${symbol} Down ${decline.toFixed(1)}%`,
            body: `${symbol} is trading at $${price}`
        }
    };

    try {
        await axios.post('https://googleapis.com', payload, {
            headers: {
                'Authorization': `key=${fcmServerKey}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (err) {
        console.error("FCM error:", err.message);
    }
}

setInterval(monitorMarket, 60000);
setTimeout(monitorMarket, 5000);

app.get('/api/status', (req, res) => {
    res.json(memoryCache);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
