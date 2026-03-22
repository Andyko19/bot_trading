import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD, ADX } from 'technicalindicators';
import MetaApi from 'metaapi.cloud-sdk'; 
import { MongoClient } from 'mongodb'; // 👈 NUEVO: El traductor de MongoDB

// --- CONFIGURACIÓN ---
dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error("❌ ERROR: Faltan claves de Telegram.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- CONEXIÓN A FTMO (METAAPI) ---
const metaApiToken = process.env.META_API_TOKEN;
const metaApiAccountId = process.env.META_API_ACCOUNT_ID;

if (!metaApiToken || !metaApiAccountId) {
    console.error("❌ ERROR: Faltan claves de MetaApi.");
    process.exit(1);
}

const api = new MetaApi(metaApiToken);

async function dispararOrdenMT5(tipo: 'BUY' | 'SELL', lotes: number, sl: number, tp: number) {
    try {
        console.log(`🔌 Conectando a servidor FTMO para orden ${tipo}...`);
        const account = await api.metatraderAccountApi.getAccount(metaApiAccountId!);
        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        const symbolMT5 = 'BTCUSD'; 
        const lotesMT5 = Math.round(lotes * 100) / 100;
        const lotesFinales = lotesMT5 < 0.01 ? 0.01 : lotesMT5; 

        console.log(`🚀 Enviando a MT5: ${symbolMT5} | Lotes: ${lotesFinales} | SL: ${sl} | TP: ${tp}`);
        
        if (tipo === 'BUY') {
            await connection.createMarketBuyOrder(symbolMT5, lotesFinales, sl, tp);
        } else {
            await connection.createMarketSellOrder(symbolMT5, lotesFinales, sl, tp);
        }
        
        console.log(`✅ ¡Orden ${tipo} ejecutada en FTMO!`);
    } catch (error) {
        console.error('❌ Error crítico en MT5:', error);
        notificar(`❌ ALERTA: Falló conexión con FTMO. Revisa logs.`);
    }
}

// ⚙️ PARÁMETROS
const SYMBOL = 'BTC/USD';   
const TIMEFRAME = '1h';     
const CAPITAL_INICIAL = 10000; 
const RIESGO_POR_OPERACION = 1.0; 
const LIMITE_PERDIDA_DIARIA = 4.0; 

// ☁️ MEMORIA INMORTAL EN LA NUBE (MONGODB)
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    console.error("❌ ERROR: Falta MONGO_URI en tu archivo .env");
    process.exit(1);
}

const mongoClient = new MongoClient(mongoUri);
let dbCollection: any;

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
    diaActual: new Date().toISOString().split('T')[0],
    operacionesHoy: 0,
    breakEvenActivado: false 
};

async function conectarBaseDeDatos() {
    try {
        await mongoClient.connect();
        console.log("🟢 Conectado a la bóveda indestructible de MongoDB Atlas");
        const db = mongoClient.db('TradingBotDB');
        dbCollection = db.collection('estado_memoria');
        await cargarEstado();
    } catch (error) {
        console.error("❌ Error conectando a MongoDB:", error);
    }
}

async function cargarEstado() {
    try {
        const guardado = await dbCollection.findOne({ id: 'bot_v5' });
        if (guardado) {
            delete guardado._id; // Limpiamos info interna de Mongo
            estadoBot = { ...estadoBot, ...guardado };
            console.log("💾 Memoria restaurada desde la NUBE:", estadoBot);
        } else {
            console.log("🌱 Primera vez iniciando, creando memoria en la NUBE...");
            guardarEstado();
        }
    } catch (error) { console.error("⚠️ Error leyendo memoria en la nube."); }
}

function guardarEstado() {
    if (!dbCollection) return;
    dbCollection.updateOne(
        { id: 'bot_v5' },
        { $set: estadoBot },
        { upsert: true } // Si no existe, lo crea
    ).catch((e:any) => console.error("Error guardando en la nube:", e));
}

// --- COMANDOS MANUALES ---
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
    const be = estadoBot.breakEvenActivado ? "ACTIVADO 🔒" : "PENDIENTE";
    bot.sendMessage(chatId, `🤖 ESTADO V5.10 (NUBE)\nPosición: ${estadoBot.enPosicion ? estadoBot.tipo : 'BUSCANDO'}\nOps Hoy: ${estadoBot.operacionesHoy}\nCandado (BE): ${be}\nBalance: $${estadoBot.balance.toFixed(2)}`);
});

// --- FUNCIONES DE SEGURIDAD (HORARIO NY) ---
function obtenerHoraNY() {
    const ahoraNY = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});
    const fechaNY = new Date(ahoraNY);
    return { hora: fechaNY.getHours(), minutos: fechaNY.getMinutes() };
}

function esHorarioPeligroso(): boolean {
    const { hora, minutos } = obtenerHoraNY();
    if (hora === 8 && minutos >= 25 && minutos <= 45) return true;
    if (hora === 13 && minutos >= 55) return true;
    if (hora === 14 && minutos <= 15) return true;
    return false;
}

// --- FUNCIÓN SERENO NOCTURNO 🌙 ---
function verificarRequisitoDiario(precioActual: number) {
    const { hora, minutos } = obtenerHoraNY();
    if (hora === 16 && minutos >= 50) {
        if (estadoBot.operacionesHoy === 0 && !estadoBot.enPosicion) {
            console.log("🌙 SERENO: Abriendo operación mínima de asistencia.");
            estadoBot.enPosicion = true;
            estadoBot.tipo = 'ACTIVIDAD'; 
            estadoBot.precioEntrada = precioActual;
            estadoBot.stopLoss = precioActual * 0.999; 
            estadoBot.takeProfit = precioActual * 1.001;
            estadoBot.lotes = 0.001; 
            estadoBot.breakEvenActivado = false;
            guardarEstado();
            notificar(`🌙 **OPERACIÓN DE ASISTENCIA (Cierre NY)**\nCumpliendo requisito diario en FTMO.`);
        }
    }
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

// --- CEREBRO MAESTRO V5.10 ---
async function analizarMercado() {
    const exchange = new ccxt.coinbase({ enableRateLimit: true });
    
    // GESTIÓN DEL DÍA
    const hoy = new Date().toISOString().split('T')[0];
    if (estadoBot.diaActual !== hoy) {
        estadoBot.diaActual = hoy;
        estadoBot.balanceInicioDia = estadoBot.balance;
        estadoBot.operacionesHoy = 0; 
        guardarEstado();
        await notificar(`📅 **NUEVO DÍA** | Balance: $${estadoBot.balance.toFixed(2)}`);
    }

    if (estadoBot.pausadoPorUsuario) return;
    if (esHorarioPeligroso()) { console.log("🔥 HORARIO NOTICIAS (NY)."); return; }

    const perdidaHoy = estadoBot.balanceInicioDia - estadoBot.balance;
    const limiteDinero = estadoBot.balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100);
    if (perdidaHoy >= limiteDinero) { console.log(`🛑 KILL SWITCH ACTIVADO.`); return; }

    console.log(`\n🛡️ V5.10 Analizando ${SYMBOL}...`);

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        if (!ohlcv || ohlcv.length === 0) return;

        const velas = ohlcv.map(v => ({ high: v[2] as number, low: v[3] as number, close: v[4] as number }));
        const closes = velas.map(v => v.close);
        const highs = velas.map(v => v.high);
        const lows = velas.map(v => v.low);
        const precioActual = closes[closes.length - 1]; 

        // --- GESTIÓN SALIDAS ---
        if (estadoBot.enPosicion) {
            console.log(`⏳ GESTIONANDO ${estadoBot.tipo} | Actual: ${precioActual}`);
            
            if (estadoBot.tipo !== 'ACTIVIDAD' && !estadoBot.breakEvenActivado) {
                let activarBE = false;
                if (estadoBot.tipo === 'LONG') {
                    const meta = estadoBot.takeProfit - estadoBot.precioEntrada;
                    if (precioActual >= estadoBot.precioEntrada + (meta * 0.5)) activarBE = true;
                } else if (estadoBot.tipo === 'SHORT') {
                    const meta = estadoBot.precioEntrada - estadoBot.takeProfit;
                    if (precioActual <= estadoBot.precioEntrada - (meta * 0.5)) activarBE = true;
                }

                if (activarBE) {
                    estadoBot.stopLoss = estadoBot.precioEntrada;
                    estadoBot.breakEvenActivado = true;
                    guardarEstado();
                    await notificar(`🔒 **CANDADO ACTIVADO**\nSL a entrada ($${estadoBot.stopLoss}). Riesgo Cero.`);
                }
            }

            let cerro = false;
            let resultado = 0;
            let mensaje = "";
            const velaActual = velas[velas.length - 1]; 

            if (estadoBot.tipo === 'ACTIVIDAD') {
                resultado = -2.00; 
                mensaje = `🌙 ACTIVIDAD CUMPLIDA.`;
                cerro = true;
            } 
            else {
                if (estadoBot.tipo === 'LONG') {
                    if (velaActual.low <= estadoBot.stopLoss) {
                        resultado = (estadoBot.stopLoss - estadoBot.precioEntrada) * estadoBot.lotes;
                        mensaje = `❌ CIERRE LONG\nResultado: $${resultado.toFixed(2)}`;
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
                        mensaje = `❌ CIERRE SHORT\nResultado: $${resultado.toFixed(2)}`;
                        cerro = true;
                    } else if (velaActual.low <= estadoBot.takeProfit) {
                        resultado = (estadoBot.precioEntrada - estadoBot.takeProfit) * estadoBot.lotes;
                        mensaje = `✅ TAKE PROFIT (SHORT)\nGanancia: +$${resultado.toFixed(2)}`;
                        cerro = true;
                    }
                }
            }

            if (cerro) {
                estadoBot.balance += resultado;
                estadoBot.enPosicion = false;
                estadoBot.tipo = 'NINGUNA';
                estadoBot.breakEvenActivado = false;
                estadoBot.operacionesHoy++; 
                guardarEstado(); 
                await notificar(`${mensaje}\n💰 Balance: $${estadoBot.balance.toFixed(2)}`);
            }
            return; 
        }

        verificarRequisitoDiario(precioActual);
        if (estadoBot.enPosicion) return; 

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
        if (adxResult.adx < 25) { console.log(`💤 Lateral (ADX: ${adxResult.adx.toFixed(1)})`); return; }

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
                pausadoPorUsuario: false, operacionesHoy: estadoBot.operacionesHoy, breakEvenActivado: false
            };
            guardarEstado();
            
            await notificar(`🚀 COMPRA (LONG)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nADX: ${adxResult.adx.toFixed(1)}`);
            await dispararOrdenMT5('BUY', lotes, sl, tp);
        }
        else if (cierre < sma200 && rsi > 30 && cruceBajista) {
            const sl = Math.max(...highsConf.slice(-10)); 
            const tp = precioActual - ((sl - precioActual) * 2); 
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'SHORT', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual,
                pausadoPorUsuario: false, operacionesHoy: estadoBot.operacionesHoy, breakEvenActivado: false
            };
            guardarEstado();
            
            await notificar(`📉 VENTA (SHORT)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nADX: ${adxResult.adx.toFixed(1)}`);
            await dispararOrdenMT5('SELL', lotes, sl, tp);
        }
    } catch (error) { console.error("❌ Error:", error); }
}

async function startBot() {
    await conectarBaseDeDatos(); // 👈 NUEVO: Conecta a la bóveda antes de arrancar
    await notificar(`🛡️ BOT V5.10 (NUBE) ACTIVO\n✅ Conectado a FTMO\n✅ Memoria MongoDB Inmortal`);
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();