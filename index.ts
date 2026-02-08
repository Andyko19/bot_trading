import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD, ADX } from 'technicalindicators';
import fs from 'fs';

// --- CONFIGURACIÓN DE LIBERTAD FINANCIERA ---
dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error("❌ ERROR: Faltan claves de Telegram.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ⚙️ PARÁMETROS
const SYMBOL = 'BTC/USD';   
const TIMEFRAME = '1h';     
const CAPITAL_INICIAL = 10000; 
const RIESGO_POR_OPERACION = 1.0; 
const LIMITE_PERDIDA_DIARIA = 4.0; 

// 💾 MEMORIA PERSISTENTE
const DB_FILE = 'estado_bot.json';

let estadoBot = {
    enPosicion: false,
    pausadoPorUsuario: false, 
    tipo: 'NINGUNA', 
    precioEntrada: 0,
    stopLoss: 0,
    takeProfit: 0,
    lotes: 0,
    balance: CAPITAL_INICIAL,
    balanceInicioDia: CAPITAL_INICIAL,
    diaActual: new Date().toISOString().split('T')[0]
};

function cargarEstado() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const guardado = JSON.parse(data);
            estadoBot = { ...estadoBot, ...guardado };
            console.log("💾 Memoria restaurada:", estadoBot);
        } catch (error) { console.error("⚠️ Error leyendo memoria."); }
    }
}

function guardarEstado() {
    fs.writeFileSync(DB_FILE, JSON.stringify(estadoBot, null, 2));
}

cargarEstado();

// --- COMANDOS MANUALES (Respaldo) ---
bot.onText(/\/pausa/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    estadoBot.pausadoPorUsuario = true;
    guardarEstado();
    bot.sendMessage(chatId, "🛑 BOT PAUSADO MANUALMENTE.");
});

bot.onText(/\/reanudar/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    estadoBot.pausadoPorUsuario = false;
    guardarEstado();
    bot.sendMessage(chatId, "✅ BOT REANUDADO MANUALMENTE.");
});

bot.onText(/\/estado/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    bot.sendMessage(chatId, `🤖 ESTADO: ${estadoBot.enPosicion ? 'EN OPERACIÓN' : 'BUSCANDO'}\nBalance: $${estadoBot.balance.toFixed(2)}`);
});

// --- FUNCIÓN ANTI-NOTICIAS (AUTO BLOCK) 🛡️ ---
function esHorarioPeligroso(): boolean {
    // Obtenemos la hora actual en Nueva York (Wall Street)
    const ahoraNY = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});
    const fechaNY = new Date(ahoraNY);
    const hora = fechaNY.getHours();
    const minutos = fechaNY.getMinutes();

    // Rango 1: 08:25 AM - 08:45 AM (CPI, NFP, GDP)
    if (hora === 8 && minutos >= 25 && minutos <= 45) return true;

    // Rango 2: 13:55 PM - 14:15 PM (1:55 - 2:15 PM) (FOMC, FED)
    // Nota: 13:55 es 1:55 PM
    if (hora === 13 && minutos >= 55) return true;
    if (hora === 14 && minutos <= 15) return true;

    return false;
}

// --- HERRAMIENTAS ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    const dineroArriesgar = balance * (riesgo / 100);
    return dineroArriesgar / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO MAESTRO V5.7 ---
async function analizarMercado() {
    const exchange = new ccxt.coinbase({ enableRateLimit: true });
    
    // 1. GESTIÓN DEL DÍA
    const hoy = new Date().toISOString().split('T')[0];
    if (estadoBot.diaActual !== hoy) {
        estadoBot.diaActual = hoy;
        estadoBot.balanceInicioDia = estadoBot.balance;
        guardarEstado();
        await notificar(`📅 **NUEVO DÍA** | Balance: $${estadoBot.balance.toFixed(2)}`);
    }

    // 2. FILTROS DE BLOQUEO (Manual + Automático)
    if (estadoBot.pausadoPorUsuario) {
        console.log("🛑 Pausado por Usuario.");
        return; 
    }

    if (esHorarioPeligroso()) {
        console.log("🔥 HORARIO DE NOTICIAS (NY). Bot en modo seguro (Pausa temporal).");
        // Si no estamos en operación, simplemente no hacemos nada.
        // Si estuviéramos en operación, dejamos que el SL/TP trabajen (ya están puestos).
        return; 
    }

    // 3. KILL SWITCH
    const perdidaHoy = estadoBot.balanceInicioDia - estadoBot.balance;
    const limiteDinero = estadoBot.balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100);
    if (perdidaHoy >= limiteDinero) {
        console.log(`🛑 KILL SWITCH ACTIVADO.`);
        return; 
    }

    console.log(`\n🛡️ V5.7 Analizando ${SYMBOL}...`);

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        if (!ohlcv || ohlcv.length === 0) return;

        const velas = ohlcv.map(v => ({
            high: v[2] as number, low: v[3] as number, close: v[4] as number
        }));
        
        const closes = velas.map(v => v.close);
        const highs = velas.map(v => v.high);
        const lows = velas.map(v => v.low);
        const precioActual = closes[closes.length - 1]; 
        
        // --- GESTIÓN SALIDAS ---
        if (estadoBot.enPosicion) {
            console.log(`⏳ GESTIONANDO ${estadoBot.tipo} | Actual: ${precioActual}`);
            let cerro = false;
            let resultado = 0;
            let mensaje = "";
            const velaActual = velas[velas.length - 1]; 

            if (estadoBot.tipo === 'LONG') {
                if (velaActual.low <= estadoBot.stopLoss) {
                    resultado = (estadoBot.stopLoss - estadoBot.precioEntrada) * estadoBot.lotes;
                    mensaje = `❌ STOP LOSS (LONG)\nPerdida: $${resultado.toFixed(2)}`;
                    cerro = true;
                } else if (velaActual.high >= estadoBot.takeProfit) {
                    resultado = (estadoBot.takeProfit - estadoBot.precioEntrada) * estadoBot.lotes;
                    mensaje = `✅ TAKE PROFIT (LONG)\nGanancia: +$${resultado.toFixed(2)}`;
                    cerro = true;
                }
            } 
            else if (estadoBot.tipo === 'SHORT') {
                if (velaActual.high >= estadoBot.stopLoss) {
                    resultado = (estadoBot.precioEntrada - estadoBot.stopLoss) * estadoBot.lotes;
                    mensaje = `❌ STOP LOSS (SHORT)\nPerdida: $${resultado.toFixed(2)}`;
                    cerro = true;
                } else if (velaActual.low <= estadoBot.takeProfit) {
                    resultado = (estadoBot.precioEntrada - estadoBot.takeProfit) * estadoBot.lotes;
                    mensaje = `✅ TAKE PROFIT (SHORT)\nGanancia: +$${resultado.toFixed(2)}`;
                    cerro = true;
                }
            }

            if (cerro) {
                estadoBot.balance += resultado;
                estadoBot.enPosicion = false;
                estadoBot.tipo = 'NINGUNA';
                guardarEstado(); 
                await notificar(`${mensaje}\n💰 Balance: $${estadoBot.balance.toFixed(2)}`);
            }
            return; 
        }

        // --- INDICADORES ---
        const closesConf = closes.slice(0, -1); 
        const highsConf = highs.slice(0, -1);
        const lowsConf = lows.slice(0, -1);

        const sma200 = SMA.calculate({ period: 200, values: closesConf }).pop();
        const rsi = RSI.calculate({ period: 14, values: closesConf }).pop();
        const macdVal = MACD.calculate({ values: closesConf, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const macdActual = macdVal[macdVal.length - 1];
        const macdPrevio = macdVal[macdVal.length - 2];
        const adxResult = ADX.calculate({ close: closesConf, high: highsConf, low: lowsConf, period: 14 }).pop();

        if (!sma200 || !rsi || !macdActual || !adxResult) return;

        if (adxResult.adx < 25) {
            console.log(`💤 Lateral (ADX: ${adxResult.adx.toFixed(1)})`);
            return; 
        }

        const cruceAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);
        const cierre = closesConf[closesConf.length-1];

        // --- ENTRADAS ---
        if (cierre > sma200 && rsi < 70 && cruceAlcista) {
            const sl = Math.min(...lowsConf.slice(-10)); 
            const tp = precioActual + ((precioActual - sl) * 2); 
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'LONG', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual,
                pausadoPorUsuario: false
            };
            guardarEstado();
            await notificar(`🚀 COMPRA (LONG)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nADX: ${adxResult.adx.toFixed(1)}`);
        }
        else if (cierre < sma200 && rsi > 30 && cruceBajista) {
            const sl = Math.max(...highsConf.slice(-10)); 
            const tp = precioActual - ((sl - precioActual) * 2); 
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'SHORT', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual,
                pausadoPorUsuario: false
            };
            guardarEstado();
            await notificar(`📉 VENTA (SHORT)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nADX: ${adxResult.adx.toFixed(1)}`);
        } else {
            console.log(`👀 Vigilando... RSI: ${rsi.toFixed(1)}`);
        }

    } catch (error) { console.error("❌ Error:", error); }
}

async function startBot() {
    await notificar(`🛡️ BOT V5.7 ACTIVO\n✅ Modo Automático Anti-Noticias (NY Time)\n✅ Comandos Manuales Listos`);
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();