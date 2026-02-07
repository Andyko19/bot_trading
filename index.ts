import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD } from 'technicalindicators';

// --- CONFIGURACIÓN ---
dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error("❌ ERROR: Faltan las claves de TELEGRAM en Railway.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

// ⚙️ PARÁMETROS
// Usamos BTC/USD porque es el estándar en Coinbase y Prop Firms
const SYMBOL = 'BTC/USD'; 
const TIMEFRAME = '1h'; 
const CAPITAL_INICIAL = 10000;
const RIESGO_POR_OPERACION = 1.0; 

// 🧠 MEMORIA DEL BOT (Simulador)
let estadoBot = {
    enPosicion: false,
    tipo: 'NINGUNA', 
    precioEntrada: 0,
    stopLoss: 0,
    takeProfit: 0,
    lotes: 0
};

// --- GESTIÓN DE RIESGO ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    return (balance * (riesgo / 100)) / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO DEL BOT (V5.1: COINBASE + RSI + MACD) ---
async function analizarMercado() {
    // CAMBIO CLAVE: Usamos COINBASE (Funciona 100% en EE.UU./Railway)
    const exchange = new ccxt.coinbase({ enableRateLimit: true });
    
    console.log(`\n🇺🇸 Analizando mercado en COINBASE (${SYMBOL})...`);

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        
        if (!ohlcv || ohlcv.length === 0) {
            console.log("⚠️ Error leyendo datos de Coinbase.");
            return;
        }

        // Limpieza de datos
        const velas = ohlcv.map(v => ({
            high: v[2] as number,
            low: v[3] as number,
            close: v[4] as number
        }));
        
        const closes = velas.map(v => v.close);
        const currentPrice = closes[closes.length - 1];
        const lastCandle = velas[velas.length - 1];

        // -----------------------------------------------------------
        // 🕵️ GESTIÓN DE POSICIONES (SIMULADOR)
        // -----------------------------------------------------------
        if (estadoBot.enPosicion) {
            console.log(`⏳ EN OPERACIÓN (${estadoBot.tipo}) - Precio: ${currentPrice}`);
            
            let cerro = false;
            let resultado = 0;
            let mensaje = "";

            if (estadoBot.tipo === 'LONG') {
                if (lastCandle.low <= estadoBot.stopLoss) {
                    resultado = (estadoBot.stopLoss - estadoBot.precioEntrada) * estadoBot.lotes;
                    mensaje = `❌ STOP LOSS (LONG)\nSalida: $${estadoBot.stopLoss}\nPérdida: $${resultado.toFixed(2)}`;
                    cerro = true;
                } else if (lastCandle.high >= estadoBot.takeProfit) {
                    resultado = (estadoBot.takeProfit - estadoBot.precioEntrada) * estadoBot.lotes;
                    mensaje = `✅ TAKE PROFIT (LONG)\nSalida: $${estadoBot.takeProfit}\nGanancia: +$${resultado.toFixed(2)}`;
                    cerro = true;
                }
            } 
            else if (estadoBot.tipo === 'SHORT') {
                if (lastCandle.high >= estadoBot.stopLoss) {
                    resultado = (estadoBot.precioEntrada - estadoBot.stopLoss) * estadoBot.lotes;
                    mensaje = `❌ STOP LOSS (SHORT)\nSalida: $${estadoBot.stopLoss}\nPérdida: $${resultado.toFixed(2)}`;
                    cerro = true;
                } else if (lastCandle.low <= estadoBot.takeProfit) {
                    resultado = (estadoBot.precioEntrada - estadoBot.takeProfit) * estadoBot.lotes;
                    mensaje = `✅ TAKE PROFIT (SHORT)\nSalida: $${estadoBot.takeProfit}\nGanancia: +$${resultado.toFixed(2)}`;
                    cerro = true;
                }
            }

            if (cerro) {
                await notificar(mensaje);
                estadoBot = { enPosicion: false, tipo: 'NINGUNA', precioEntrada: 0, stopLoss: 0, takeProfit: 0, lotes: 0 };
            }
            return; 
        }

        // -----------------------------------------------------------
        // 🔍 BÚSQUEDA DE ENTRADAS (ESTRATEGIA)
        // -----------------------------------------------------------
        const sma200Values = SMA.calculate({ period: 200, values: closes });
        const sma200 = sma200Values[sma200Values.length - 1];
        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const rsi = rsiValues[rsiValues.length - 1];
        const macdValues = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        
        const macdActual = macdValues[macdValues.length - 1];
        const macdPrevio = macdValues[macdValues.length - 2];

        if (!sma200 || !rsi || !macdActual) return;

        const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);

        // LONG
        if (currentPrice > sma200 && rsi < 70 && cruceMacdAlcista) {
            const lowPrices = velas.map(v => v.low);
            const stopLoss = Math.min(...lowPrices.slice(-10));
            const riesgo = currentPrice - stopLoss;
            const takeProfit = currentPrice + (riesgo * 2);
            const lotes = calcularTamanoPosicion(CAPITAL_INICIAL, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            estadoBot = { enPosicion: true, tipo: 'LONG', precioEntrada: currentPrice, stopLoss, takeProfit, lotes };
            const msg = `🚀 COMPRA (LONG)\nPrecio: $${currentPrice}\nSL: $${stopLoss}\nTP: $${takeProfit}\n\n✅ Confirmado V5.1 (Coinbase)`;
            console.log("🔥 LONG DETECTADO");
            await notificar(msg);
        }

        // SHORT
        else if (currentPrice < sma200 && rsi > 30 && cruceMacdBajista) {
            const highPrices = velas.map(v => v.high);
            const stopLoss = Math.max(...highPrices.slice(-10));
            const riesgo = stopLoss - currentPrice;
            const takeProfit = currentPrice - (riesgo * 2);
            const lotes = calcularTamanoPosicion(CAPITAL_INICIAL, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            estadoBot = { enPosicion: true, tipo: 'SHORT', precioEntrada: currentPrice, stopLoss, takeProfit, lotes };
            const msg = `📉 VENTA (SHORT)\nPrecio: $${currentPrice}\nSL: $${stopLoss}\nTP: $${takeProfit}\n\n✅ Confirmado V5.1 (Coinbase)`;
            console.log("🔥 SHORT DETECTADO");
            await notificar(msg);
        } else {
            console.log(`💤 Bot V5.1 Vigilando. RSI: ${rsi.toFixed(2)}`);
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

// ARRANQUE
async function startBot() {
    await notificar("🤖 BOT V5.1 REINICIADO\nFuente: Coinbase (USA)\nModo: Señales Telegram");
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();