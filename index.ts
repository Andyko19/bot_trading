import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD, ADX } from 'technicalindicators';
import MetaApi from 'metaapi.cloud-sdk'; 
import { MongoClient } from 'mongodb'; 

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

// ⚙️ PARÁMETROS
const SYMBOL = 'BTC/USDT';   // Cambiado a USDT para compatibilidad con Binance
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
    diaActual: new Date().toISOString().split('T'),
    operacionesHoy: 0,
    breakEvenActivado: false 
};

async function conectarBaseDeDatos() {
    try {
        await mongoClient.connect();
        console.log("🟢 Conectado a MongoDB Atlas");
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
            delete guardado._id; 
            estadoBot = { ...estadoBot, ...guardado };
            console.log("💾 Memoria restaurada desde la NUBE.");
        } else {
            guardarEstado();
        }
    } catch (error) { console.error("⚠️ Error leyendo memoria en la nube."); }
}

function guardarEstado() {
    if (!dbCollection) return;
    dbCollection.updateOne(
        { id: 'bot_v5' },
        { $set: estadoBot },
        { upsert: true } 
    ).catch((e:any) => console.error("Error guardando en la nube:", e));
}

// 🔄 SINCRONIZADOR DE SALDO REAL FTMO
async function sincronizarSaldoFTMO() {
    try {
        const account = await api.metatraderAccountApi.getAccount(metaApiAccountId!);
        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();
        const info = await connection.getAccountInformation();
        
        if (info && info.balance) {
            estadoBot.balance = info.balance;
            guardarEstado();
            console.log(`🔄 Saldo sincronizado con FTMO: $${estadoBot.balance.toFixed(2)}`);
        }
    } catch (error) {
        console.error("❌ Error sincronizando saldo con FTMO:", error);
    }
}

async function dispararOrdenMT5(tipo: 'BUY' | 'SELL', lotes: number, sl: number, tp: number) {
    try {
        const account = await api.metatraderAccountApi.getAccount(metaApiAccountId!);
        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        const symbolMT5 = 'BTCUSD'; 
        const lotesMT5 = Math.round(lotes * 100) / 100;
        const lotesFinales = lotesMT5 < 0.01 ? 0.01 : lotesMT5; 
        
        if (tipo === 'BUY') {
            await connection.createMarketBuyOrder(symbolMT5, lotesFinales, sl, tp);
        } else {
            await connection.createMarketSellOrder(symbolMT5, lotesFinales, sl, tp);
        }
        console.log(`✅ ¡Orden ${tipo} ejecutada en FTMO!`);
    } catch (error) {
        console.error('❌ Error crítico en MT5:', error);
        notificar(`❌ ALERTA: Falló conexión con FTMO.`);
    }
}

// 🌙 GATILLO FÍSICO SERENO NOCTURNO
async function ejecutarSerenoFisico() {
    try {
        const account = await api.metatraderAccountApi.getAccount(metaApiAccountId!);
        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        console.log(`🌙 SERENO: Abriendo operación mínima en FTMO...`);
        const order = await connection.createMarketBuyOrder('BTCUSD', 0.01, 0, 0);
        
        console.log(`⏳ Orden abierta. Esperando 5 segundos para cerrar...`);
        await new Promise(r => setTimeout(r, 5000)); 
        
        await connection.closePosition(order.positionId, {});
        console.log(`✅ SERENO COMPLETADO: Orden cerrada físicamente.`);
        
        await sincronizarSaldoFTMO(); 
        await notificar(`🌙 **SERENO NOCTURNO EJECUTADO**\nDía de trading registrado oficialmente en FTMO.\n💰 Nuevo Saldo: $${estadoBot.balance.toFixed(2)}`);
    } catch (error) {
        console.error("❌ Error en Sereno Físico:", error);
        notificar(`❌ ALERTA: Falló el Sereno Nocturno en FTMO.`);
    }
}

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

function verificarRequisitoDiario() {
    const { hora, minutos } = obtenerHoraNY();
    if (hora === 16 && minutos >= 50) {
        if (estadoBot.operacionesHoy === 0 && !estadoBot.enPosicion) {
            estadoBot.operacionesHoy++; 
            guardarEstado();
            ejecutarSerenoFisico(); 
        }
    }
}

function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    const dineroArriesgar = balance * (riesgo / 100);
    return dineroArriesgar / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

bot.onText(/\/estado/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    bot.sendMessage(chatId, `🤖 ESTADO V5.11 (Sincronizado)\nPosición: ${estadoBot.enPosicion ? estadoBot.tipo : 'BUSCANDO'}\nOps Hoy: ${estadoBot.operacionesHoy}\nBalance Real: $${estadoBot.balance.toFixed(2)}`);
});

async function analizarMercado() {
    // --- CORRECCIÓN CLAVE: CAMBIO A BINANCE Y AUMENTO DE TIMEOUT ---
    const exchange = new ccxt.binance({ 
        enableRateLimit: true,
        timeout: 30000 // 30 segundos para evitar RequestTimeout en Railway
    });
    
    const hoy = new Date().toISOString().split('T');
    if (estadoBot.diaActual !== hoy) {
        estadoBot.diaActual = hoy;
        await sincronizarSaldoFTMO(); 
        estadoBot.balanceInicioDia = estadoBot.balance;
        estadoBot.operacionesHoy = 0; 
        guardarEstado();
        await notificar(`📅 **NUEVO DÍA** | Saldo Sincronizado FTMO: $${estadoBot.balance.toFixed(2)}`);
    }

    if (estadoBot.pausadoPorUsuario) return;
    if (esHorarioPeligroso()) return;

    const perdidaHoy = estadoBot.balanceInicioDia - estadoBot.balance;
    const limiteDinero = estadoBot.balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100);
    if (perdidaHoy >= limiteDinero) return;

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        if (!ohlcv || ohlcv.length === 0) return;

        const velas = ohlcv.map(v => ({
            high: Number(v),
            low: Number(v),
            close: Number(v)
        }));
        
        const closes = velas.map(v => v.close);
        const highs = velas.map(v => v.high);
        const lows = velas.map(v => v.low); 
        const precioActual = closes[closes.length - 1]; 

        // --- GESTIÓN SALIDAS ---
        if (estadoBot.enPosicion) {
            if (!estadoBot.breakEvenActivado) {
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
            let mensaje = "";
            const velaActual = velas[velas.length - 1]; 

            if (estadoBot.tipo === 'LONG') {
                if (velaActual.low <= estadoBot.stopLoss) { mensaje = `❌ CIERRE LONG (Stop Loss)`; cerro = true; } 
                else if (velaActual.high >= estadoBot.takeProfit) { mensaje = `✅ TAKE PROFIT (LONG)`; cerro = true; }
            } 
            else if (estadoBot.tipo === 'SHORT') {
                if (velaActual.high >= estadoBot.stopLoss) { mensaje = `❌ CIERRE SHORT (Stop Loss)`; cerro = true; } 
                else if (velaActual.low <= estadoBot.takeProfit) { mensaje = `✅ TAKE PROFIT (SHORT)`; cerro = true; }
            }

            if (cerro) {
                estadoBot.enPosicion = false;
                estadoBot.tipo = 'NINGUNA';
                estadoBot.breakEvenActivado = false;
                estadoBot.operacionesHoy++; 
                await sincronizarSaldoFTMO(); 
                guardarEstado(); 
                await notificar(`${mensaje}\n💰 Saldo Actualizado FTMO: $${estadoBot.balance.toFixed(2)}`);
            }
            return; 
        }

        verificarRequisitoDiario();
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
        if (adxResult.adx < 25) return;

        const cruceAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);
        const cierre = closesConf[closesConf.length-1];

        // --- ENTRADAS ---
        if (cierre > sma200 && rsi < 70 && cruceAlcista) {
            await sincronizarSaldoFTMO(); 
            const sl = Math.min(...lowsConf.slice(-10)); 
            const tp = precioActual + ((precioActual - sl) * 2); 
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot.enPosicion = true; estadoBot.tipo = 'LONG'; estadoBot.precioEntrada = precioActual; 
            estadoBot.stopLoss = sl; estadoBot.takeProfit = tp; estadoBot.lotes = lotes; estadoBot.breakEvenActivado = false;
            guardarEstado();
            
            await notificar(`🚀 COMPRA (LONG)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}`);
            await dispararOrdenMT5('BUY', lotes, sl, tp);
        }
        else if (cierre < sma200 && rsi > 30 && cruceBajista) {
            await sincronizarSaldoFTMO(); 
            const sl = Math.max(...highsConf.slice(-10)); 
            const tp = precioActual - ((sl - precioActual) * 2); 
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot.enPosicion = true; estadoBot.tipo = 'SHORT'; estadoBot.precioEntrada = precioActual; 
            estadoBot.stopLoss = sl; estadoBot.takeProfit = tp; estadoBot.lotes = lotes; estadoBot.breakEvenActivado = false;
            guardarEstado();
            
            await notificar(`📉 VENTA (SHORT)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}`);
            await dispararOrdenMT5('SELL', lotes, sl, tp);
        }
    } catch (error) { 
        console.error("❌ Error en análisis:", error); 
    }
}

async function startBot() {
    await conectarBaseDeDatos(); 
    await sincronizarSaldoFTMO(); 
    await notificar(`🛡️ BOT V5.11 (CORREGIDO) ACTIVO\n✅ Días mínimos garantizados\n💰 Saldo Inicial: $${estadoBot.balance.toFixed(2)}`);
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();