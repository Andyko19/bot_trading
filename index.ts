import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD } from 'technicalindicators';

// --- CONFIGURACIÓN SEGURA PARA NUBE ---
// Intentamos cargar .env, pero si no existe (como en Railway), NO fallamos.
dotenv.config(); 

// Verificamos que las claves existan en la memoria del sistema
const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_SECRET;

if (!token || !chatId || !apiKey || !apiSecret) {
    console.error("❌ ERROR CRÍTICO: Faltan variables de entorno en Railway.");
    console.error("   Asegúrate de haberlas agregado en la pestaña 'Variables'.");
    // Solo aquí cerramos si faltan claves reales
    process.exit(1); 
}

const bot = new TelegramBot(token, { polling: false });

// ⚙️ PARÁMETROS CUENTA DE FONDEO ($10k)
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h'; 
const CAPITAL_CUENTA = 10000; 
const RIESGO_POR_OPERACION = 1.0; 

// --- GESTIÓN DE RIESGO ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    return (balance * (riesgo / 100)) / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO DEL BOT (V4: MACD + RSI + SMA200) ---
async function analizarMercado() {
    const exchange = new ccxt.binance({
        apiKey: apiKey,
        secret: apiSecret,
        enableRateLimit: true
    });
    
    // MODO TESTNET (Cámbialo a false solo cuando operes con dinero real)
    exchange.setSandboxMode(true); 

    console.log(`\n🔍 Analizando ${SYMBOL} en la Nube...`);

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        
        // Limpieza de datos
        const velas = ohlcv.filter(v => v[4] !== undefined);
        const closes = velas.map(v => v[4] as number);
        const highs = velas.map(v => v[2] as number);
        const lows = velas.map(v => v[3] as number);
        const currentPrice = closes[closes.length - 1];

        // INDICADORES
        const sma200Values = SMA.calculate({ period: 200, values: closes });
        const sma200 = sma200Values[sma200Values.length - 1];

        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const rsi = rsiValues[rsiValues.length - 1];

        const macdValues = MACD.calculate({
            values: closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });
        const macdActual = macdValues[macdValues.length - 1];
        const macdPrevio = macdValues[macdValues.length - 2];

        if (!sma200 || !rsi || !macdActual) {
            console.log("⚠️ Recopilando más datos...");
            return;
        }

        // REGLAS DE ESTRATEGIA
        const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);

        // --- COMPRA (LONG) ---
        if (currentPrice > sma200 && rsi < 70 && cruceMacdAlcista) {
            const stopLoss = Math.min(...lows.slice(-10));
            const riesgo = currentPrice - stopLoss;
            const takeProfit = currentPrice + (riesgo * 2);
            const lotes = calcularTamanoPosicion(CAPITAL_CUENTA, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            // EJECUCIÓN TESTNET
            // const orden = await exchange.createOrder(SYMBOL, 'market', 'buy', 0.001); // Descomentar para ejecutar orden real
            
            const mensaje = `🚀 SEÑAL DE COMPRA (LONG)\n\nPrecio: $${currentPrice}\nStop Loss: $${stopLoss}\nTP: $${takeProfit}\nLotes: ${lotes.toFixed(4)} BTC\n\n✅ Confirmado V4 (Nube).`;
            console.log("🔥 OPORTUNIDAD LONG");
            await notificar(mensaje);
        }

        // --- VENTA (SHORT) ---
        else if (currentPrice < sma200 && rsi > 30 && cruceMacdBajista) {
            const stopLoss = Math.max(...highs.slice(-10));
            const riesgo = stopLoss - currentPrice;
            const takeProfit = currentPrice - (riesgo * 2);
            const lotes = calcularTamanoPosicion(CAPITAL_CUENTA, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            // EJECUCIÓN TESTNET
            // const orden = await exchange.createOrder(SYMBOL, 'market', 'sell', 0.001); // Descomentar para ejecutar orden real

            const mensaje = `📉 SEÑAL DE VENTA (SHORT)\n\nPrecio: $${currentPrice}\nStop Loss: $${stopLoss}\nTP: $${takeProfit}\nLotes: ${lotes.toFixed(4)} BTC\n\n✅ Confirmado V4 (Nube).`;
            console.log("🔥 OPORTUNIDAD SHORT");
            await notificar(mensaje);
        } else {
            console.log(`💤 Bot V4 Activo. Mercado estable. (RSI: ${rsi.toFixed(2)})`);
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

// Bucle Infinito
async function startBot() {
    await notificar("☁️ BOT V4 EN LA NUBE: Sistema reiniciado y estable.");
    setInterval(analizarMercado, 60 * 1000); // 1 minuto
}

startBot();