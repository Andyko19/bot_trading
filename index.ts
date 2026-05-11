import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD, ADX } from 'technicalindicators';
import MetaApi from 'metaapi.cloud-sdk';
import { MongoClient } from 'mongodb';

// ===============================
// CONFIG
// ===============================

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error('❌ ERROR: Faltan claves de Telegram');
    process.exit(1);
}

const metaApiToken = process.env.META_API_TOKEN;
const metaApiAccountId = process.env.META_API_ACCOUNT_ID;

if (!metaApiToken || !metaApiAccountId) {
    console.error('❌ ERROR: Faltan claves de MetaApi');
    process.exit(1);
}

const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    console.error('❌ ERROR: Falta MONGO_URI');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const api = new MetaApi(metaApiToken);

const mongoClient = new MongoClient(mongoUri);

// ===============================
// PARAMETROS
// ===============================

const SYMBOL = 'BTC/USD';
const TIMEFRAME = '1h';

const CAPITAL_INICIAL = 10000;

const RIESGO_POR_OPERACION = 1.0;

const LIMITE_PERDIDA_DIARIA = 4.0;

// ===============================
// ESTADO GLOBAL
// ===============================

let dbCollection: any;

let analizando = false;

let ultimaAlertaError = 0;

let connection: any;

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

// ===============================
// BASE DATOS
// ===============================

async function conectarBaseDeDatos() {
    try {
        await mongoClient.connect();

        console.log('🟢 MongoDB conectado');

        const db = mongoClient.db('TradingBotDB');

        dbCollection = db.collection('estado_memoria');

        await cargarEstado();

    } catch (error) {
        console.error('❌ Error MongoDB:', error);
    }
}

async function cargarEstado() {

    try {

        const guardado = await dbCollection.findOne({
            id: 'bot_final'
        });

        if (guardado) {

            delete guardado._id;

            estadoBot = {
                ...estadoBot,
                ...guardado
            };

            console.log('💾 Estado restaurado');

        } else {

            await guardarEstado();

        }

    } catch (error) {

        console.error('❌ Error cargando estado');

    }

}

async function guardarEstado() {

    if (!dbCollection) return;

    try {

        await dbCollection.updateOne(
            { id: 'bot_final' },
            { $set: estadoBot },
            { upsert: true }
        );

    } catch (error) {

        console.error('❌ Error guardando estado');

    }

}

// ===============================
// TELEGRAM
// ===============================

async function notificar(msg: string) {

    try {

        await bot.sendMessage(chatId!, msg);

    } catch (error) {

        console.error('❌ Error Telegram');

    }

}

// ===============================
// FTMO CONNECTION
// ===============================

async function obtenerConexion() {

    if (connection) return connection;

    const account = await api.metatraderAccountApi.getAccount(
        metaApiAccountId!
    );

    if (account.state !== 'DEPLOYED') {

        console.log('⚠️ Desplegando cuenta...');

        await account.deploy();

    }

    connection = account.getRPCConnection();

    await connection.connect();

    await connection.waitSynchronized(60000);

    console.log('🟢 FTMO conectado');

    return connection;

}

// ===============================
// SALDO FTMO
// ===============================

async function sincronizarSaldoFTMO() {

    try {

        const conn = await obtenerConexion();

        const info = await conn.getAccountInformation();

        if (info?.balance) {

            estadoBot.balance = info.balance;

            await guardarEstado();

            console.log(
                `💰 Balance FTMO: ${estadoBot.balance}`
            );

        }

    } catch (error) {

        console.error('❌ Error saldo FTMO');

    }

}

// ===============================
// CERRAR POSICIONES FTMO
// ===============================

async function cerrarPosicionesFTMO() {

    try {

        const conn = await obtenerConexion();

        const posiciones = await conn.getPositions();

        if (!posiciones.length) return;

        for (const posicion of posiciones) {

            try {

                await conn.closePosition(posicion.id);

                console.log('✅ Posición cerrada');

            } catch (error) {

                console.error('❌ Error cerrando posición');

            }

        }

    } catch (error) {

        console.error('❌ Error obteniendo posiciones');

    }

}

// ===============================
// ORDENES
// ===============================

async function dispararOrdenMT5(
    tipo: 'BUY' | 'SELL',
    lotes: number,
    sl: number,
    tp: number
): Promise<boolean> {

    try {

        const conn = await obtenerConexion();

        const symbol = 'BTCUSD';

        const volumen = Math.max(
            0.01,
            Math.round(lotes * 100) / 100
        );

        if (tipo === 'BUY') {

            await conn.createMarketBuyOrder(
                symbol,
                volumen,
                sl,
                tp
            );

        } else {

            await conn.createMarketSellOrder(
                symbol,
                volumen,
                sl,
                tp
            );

        }

        console.log(`✅ Orden ${tipo} ejecutada`);

        return true;

    } catch (error: any) {

        console.error('❌ Error orden:', error.message);

        const ahora = Date.now();

        if (ahora - ultimaAlertaError > 60000) {

            ultimaAlertaError = ahora;

            await notificar(
                '⚠️ Error enviando orden a FTMO'
            );

        }

        return false;

    }

}

// ===============================
// HORARIO NY
// ===============================

function obtenerHoraNY() {

    const ahoraNY = new Date().toLocaleString(
        'en-US',
        { timeZone: 'America/New_York' }
    );

    const fecha = new Date(ahoraNY);

    return {
        hora: fecha.getHours(),
        minutos: fecha.getMinutes()
    };

}

function esHorarioPeligroso() {

    const { hora, minutos } = obtenerHoraNY();

    if (hora === 8 && minutos >= 25 && minutos <= 45)
        return true;

    if (hora === 13 && minutos >= 55)
        return true;

    if (hora === 14 && minutos <= 15)
        return true;

    return false;

}

// ===============================
// LOTAJE
// ===============================

function calcularTamanoPosicion(
    balance: number,
    riesgo: number,
    entrada: number,
    sl: number
) {

    const distancia = Math.abs(entrada - sl);

    if (distancia === 0) return 0;

    const dinero = balance * (riesgo / 100);

    return dinero / distancia;

}

// ===============================
// TELEGRAM COMMANDS
// ===============================

bot.onText(/\/estado/, async (msg) => {

    if (msg.chat.id.toString() !== chatId)
        return;

    await bot.sendMessage(
        chatId,
        `
🤖 BOT ONLINE

Posición: ${estadoBot.enPosicion ? estadoBot.tipo : 'NINGUNA'}

Balance: $${estadoBot.balance.toFixed(2)}

Operaciones Hoy: ${estadoBot.operacionesHoy}
`
    );

});

// ===============================
// ANALISIS
// ===============================

async function analizarMercado() {

    if (analizando) return;

    analizando = true;

    try {

        const exchange = new ccxt.coinbase({
            enableRateLimit: true,
            timeout: 30000
        });

        // ==========================
        // SINCRONIZACION POSICIONES
        // ==========================

        try {

            const conn = await obtenerConexion();

            const posiciones = await conn.getPositions();

            if (posiciones.length > 0) {

                const p = posiciones[0];

                if (!estadoBot.enPosicion) {

                    estadoBot.enPosicion = true;

                    estadoBot.tipo =
                        p.type === 'POSITION_TYPE_BUY'
                            ? 'LONG'
                            : 'SHORT';

                    estadoBot.precioEntrada =
                        p.openPrice || 0;

                    estadoBot.stopLoss =
                        p.stopLoss || 0;

                    estadoBot.takeProfit =
                        p.takeProfit || 0;

                    await guardarEstado();

                    await notificar(
                        '⚠️ Posición detectada en FTMO'
                    );

                }

            } else {

                if (estadoBot.enPosicion) {

                    estadoBot.enPosicion = false;

                    estadoBot.tipo = 'NINGUNA';

                    estadoBot.breakEvenActivado = false;

                    await guardarEstado();

                    await notificar(
                        'ℹ️ FTMO sin posiciones'
                    );

                }

            }

        } catch (error) {

            console.error(
                '❌ Error sincronización posiciones'
            );

        }

        // ==========================
        // NUEVO DIA
        // ==========================

        const hoy = new Date()
            .toISOString()
            .split('T')[0];

        if (estadoBot.diaActual !== hoy) {

            estadoBot.diaActual = hoy;

            estadoBot.operacionesHoy = 0;

            await sincronizarSaldoFTMO();

            estadoBot.balanceInicioDia =
                estadoBot.balance;

            await guardarEstado();

            await notificar(
                `📅 Nuevo día\n💰 Balance: $${estadoBot.balance.toFixed(2)}`
            );

        }

        if (estadoBot.pausadoPorUsuario)
            return;

        if (esHorarioPeligroso())
            return;

        const perdida =
            estadoBot.balanceInicioDia -
            estadoBot.balance;

        const limite =
            estadoBot.balanceInicioDia *
            (LIMITE_PERDIDA_DIARIA / 100);

        if (perdida >= limite) {

            console.log(
                '🛑 Limite diario alcanzado'
            );

            return;

        }

        // ==========================
        // DATOS MERCADO
        // ==========================

        const ohlcv = await exchange.fetchOHLCV(
            SYMBOL,
            TIMEFRAME,
            undefined,
            300
        );

        if (!ohlcv?.length) return;

        const velas = ohlcv.map(v => ({
            high: Number(v[2]),
            low: Number(v[3]),
            close: Number(v[4])
        }));

        const closes = velas.map(v => v.close);

        const highs = velas.map(v => v.high);

        const lows = velas.map(v => v.low);

        const precioActual =
            closes[closes.length - 1];

        // ==========================
        // GESTION POSICION
        // ==========================

        if (estadoBot.enPosicion) {

            const velaActual =
                velas[velas.length - 1];

            let cerrar = false;

            let mensaje = '';

            if (estadoBot.tipo === 'LONG') {

                if (
                    velaActual.low <=
                    estadoBot.stopLoss
                ) {

                    cerrar = true;

                    mensaje = '❌ SL LONG';

                }

                if (
                    velaActual.high >=
                    estadoBot.takeProfit
                ) {

                    cerrar = true;

                    mensaje = '✅ TP LONG';

                }

            }

            if (estadoBot.tipo === 'SHORT') {

                if (
                    velaActual.high >=
                    estadoBot.stopLoss
                ) {

                    cerrar = true;

                    mensaje = '❌ SL SHORT';

                }

                if (
                    velaActual.low <=
                    estadoBot.takeProfit
                ) {

                    cerrar = true;

                    mensaje = '✅ TP SHORT';

                }

            }

            // BREAK EVEN

            if (!estadoBot.breakEvenActivado) {

                let activarBE = false;

                if (estadoBot.tipo === 'LONG') {

                    const mitad =
                        estadoBot.precioEntrada +
                        (
                            (
                                estadoBot.takeProfit -
                                estadoBot.precioEntrada
                            ) * 0.5
                        );

                    if (precioActual >= mitad)
                        activarBE = true;

                }

                if (estadoBot.tipo === 'SHORT') {

                    const mitad =
                        estadoBot.precioEntrada -
                        (
                            (
                                estadoBot.precioEntrada -
                                estadoBot.takeProfit
                            ) * 0.5
                        );

                    if (precioActual <= mitad)
                        activarBE = true;

                }

                if (activarBE) {

                    estadoBot.breakEvenActivado = true;

                    estadoBot.stopLoss =
                        estadoBot.precioEntrada;

                    await guardarEstado();

                    await notificar(
                        '🔒 Break Even activado'
                    );

                }

            }

            if (cerrar) {

                await cerrarPosicionesFTMO();

                estadoBot.enPosicion = false;

                estadoBot.tipo = 'NINGUNA';

                estadoBot.breakEvenActivado = false;

                estadoBot.operacionesHoy++;

                await sincronizarSaldoFTMO();

                await guardarEstado();

                await notificar(
                    `${mensaje}\n💰 Balance: $${estadoBot.balance.toFixed(2)}`
                );

            }

            return;

        }

        // ==========================
        // INDICADORES
        // ==========================

        const closesConf = closes.slice(0, -1);

        const highsConf = highs.slice(0, -1);

        const lowsConf = lows.slice(0, -1);

        const sma200 = SMA.calculate({
            period: 200,
            values: closesConf
        }).pop();

        const rsi = RSI.calculate({
            period: 14,
            values: closesConf
        }).pop();

        const macd = MACD.calculate({
            values: closesConf,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });

        if (macd.length < 2) return;

        const macdActual =
            macd[macd.length - 1];

        const macdPrevio =
            macd[macd.length - 2];

        if (!macdActual || !macdPrevio)
            return;

        const adx = ADX.calculate({
            close: closesConf,
            high: highsConf,
            low: lowsConf,
            period: 14
        }).pop();

        if (
            !sma200 ||
            !rsi ||
            !adx
        ) return;

        if (adx.adx < 20)
            return;

        const cruceAlcista =
            macdPrevio.MACD! <
            macdPrevio.signal! &&
            macdActual.MACD! >
            macdActual.signal!;

        const cruceBajista =
            macdPrevio.MACD! >
            macdPrevio.signal! &&
            macdActual.MACD! <
            macdActual.signal!;

        const cierre =
            closesConf[closesConf.length - 1];

        // ==========================
        // ENTRADAS LONG
        // ==========================

        if (
            cierre > sma200 &&
            rsi < 70 &&
            cruceAlcista
        ) {

            await sincronizarSaldoFTMO();

            const sl = Math.min(
                ...lowsConf.slice(-10)
            );

            const tp =
                precioActual +
                (
                    (
                        precioActual - sl
                    ) * 2
                );

            const lotes =
                calcularTamanoPosicion(
                    estadoBot.balance,
                    RIESGO_POR_OPERACION,
                    precioActual,
                    sl
                );

            const ejecutada =
                await dispararOrdenMT5(
                    'BUY',
                    lotes,
                    sl,
                    tp
                );

            if (!ejecutada) return;

            estadoBot.enPosicion = true;

            estadoBot.tipo = 'LONG';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss = sl;

            estadoBot.takeProfit = tp;

            estadoBot.lotes = lotes;

            estadoBot.breakEvenActivado = false;

            await guardarEstado();

            await notificar(
                `
🚀 LONG

Entrada: ${precioActual}

SL: ${sl}

TP: ${tp}
`
            );

        }

        // ==========================
        // ENTRADAS SHORT
        // ==========================

        else if (
            cierre < sma200 &&
            rsi > 30 &&
            cruceBajista
        ) {

            await sincronizarSaldoFTMO();

            const sl = Math.max(
                ...highsConf.slice(-10)
            );

            const tp =
                precioActual -
                (
                    (
                        sl - precioActual
                    ) * 2
                );

            const lotes =
                calcularTamanoPosicion(
                    estadoBot.balance,
                    RIESGO_POR_OPERACION,
                    precioActual,
                    sl
                );

            const ejecutada =
                await dispararOrdenMT5(
                    'SELL',
                    lotes,
                    sl,
                    tp
                );

            if (!ejecutada) return;

            estadoBot.enPosicion = true;

            estadoBot.tipo = 'SHORT';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss = sl;

            estadoBot.takeProfit = tp;

            estadoBot.lotes = lotes;

            estadoBot.breakEvenActivado = false;

            await guardarEstado();

            await notificar(
                `
📉 SHORT

Entrada: ${precioActual}

SL: ${sl}

TP: ${tp}
`
            );

        }

    } catch (error) {

        console.error('❌ Error análisis:', error);

    } finally {

        analizando = false;

    }

}

// ===============================
// LOOP PRINCIPAL
// ===============================

async function loopBot() {

    while (true) {

        try {

            await analizarMercado();

        } catch (error) {

            console.error(error);

        }

        await new Promise(
            r => setTimeout(r, 60000)
        );

    }

}

// ===============================
// START
// ===============================

async function startBot() {

    await conectarBaseDeDatos();

    await sincronizarSaldoFTMO();

    await notificar(
        `
🛡️ BOT FINAL ACTIVADO

💰 Balance: $${estadoBot.balance.toFixed(2)}
`
    );

    await loopBot();

}

startBot();