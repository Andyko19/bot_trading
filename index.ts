/* =========================================================
   BOT FTMO V18 INSTITUCIONAL
   SMART FTMO DAILY LOSS FIX
   PRICE ACTION + ESTRUCTURA + FTMO SAFE
========================================================= */

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

import {
    SMA,
    RSI,
    MACD,
    ADX,
    ATR
} from 'technicalindicators';

import MetaApi from 'metaapi.cloud-sdk';
import { MongoClient } from 'mongodb';

dotenv.config();

/* =========================================================
   VARIABLES
========================================================= */

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const META_API_TOKEN = process.env.META_API_TOKEN!;
const META_API_ACCOUNT_ID = process.env.META_API_ACCOUNT_ID!;

const MONGO_URI = process.env.MONGO_URI!;

if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID ||
    !META_API_TOKEN ||
    !META_API_ACCOUNT_ID ||
    !MONGO_URI
) {
    console.error('❌ Variables faltantes');
    process.exit(1);
}

/* =========================================================
   CONFIG GENERAL
========================================================= */

const SYMBOL = 'BTCUSD';
const TIMEFRAME = '1h';

const CAPITAL_INICIAL = 10000;

const RIESGO_POR_OPERACION = 0.005;

const LIMITE_DD_DIARIO = 500;
const LIMITE_DD_TOTAL = 1000;

const MAX_SPREAD = 50;

const MAX_OPERACIONES_DIA = 2;

const LOOP_ANALISIS_MS = 60000;

const MIN_ADX = 25;
const MIN_ATR = 40;

const VELAS_SOPORTE_RESISTENCIA = 50;
const VELAS_CONSOLIDACION = 8;

const ATR_MULTIPLICADOR_SL = 1.5;
const ATR_MULTIPLICADOR_TP = 3;

/* =========================================================
   NOTICIAS
========================================================= */

const HORARIOS_NOTICIAS = [
    '13:30',
    '15:00',
    '18:00'
];

const PAUSA_NOTICIAS_MINUTOS = 25;

/* =========================================================
   INSTANCIAS
========================================================= */

const bot = new TelegramBot(
    TELEGRAM_TOKEN,
    { polling: true }
);

const metaApi = new MetaApi(
    META_API_TOKEN
);

const mongoClient = new MongoClient(
    MONGO_URI
);

let rpcConnection: any;
let dbCollection: any;

let analizando = false;
let botPausado = false;

/* =========================================================
   ESTADO
========================================================= */

let estadoBot = {

    enPosicion: false,

    tipo: 'NINGUNA',

    precioEntrada: 0,

    stopLoss: 0,

    takeProfit: 0,

    lotes: 0,

    balance: CAPITAL_INICIAL,

    equity: CAPITAL_INICIAL,

    balanceInicioDia: CAPITAL_INICIAL,

    perdidaDiariaActual: 0,

    perdidaTotalActual: 0,

    operacionesHoy: 0,

    operoHoyFTMO: false,

    breakEvenActivado: false,

    ticket: null as any,

    pausaPorNoticias: false,

    pausaNoticiasHasta: 0,

    ultimaNoticia: '',

    limiteDiarioNotificado: false,

    diaActual:
        new Date()
            .toISOString()
            .split('T')[0]
};

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms: number) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

function horaUTC() {

    const d = new Date();

    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function esFinDeSemana() {

    const d = new Date().getUTCDay();

    return d === 0 || d === 6;
}

/* =========================================================
   TELEGRAM
========================================================= */

async function notificar(msg: string) {

    try {

        await bot.sendMessage(
            TELEGRAM_CHAT_ID,
            msg
        );

    } catch {}
}

/* =========================================================
   MONGO
========================================================= */

async function conectarMongo() {

    await mongoClient.connect();

    const db =
        mongoClient.db('TradingBotDB');

    dbCollection =
        db.collection('estado_v18');

    const guardado =
        await dbCollection.findOne({
            id: 'BOT_V18'
        });

    if (guardado) {

        delete guardado._id;

        estadoBot = {
            ...estadoBot,
            ...guardado
        };

        console.log('💾 Estado restaurado');
    }
}

async function guardarEstado() {

    await dbCollection.updateOne(
        { id: 'BOT_V18' },
        {
            $set: {
                ...estadoBot,
                botPausado
            }
        },
        { upsert: true }
    );
}

/* =========================================================
   METAAPI
========================================================= */

async function conectarMetaApi() {

    const account =
        await metaApi
            .metatraderAccountApi
            .getAccount(
                META_API_ACCOUNT_ID
            );

    if (
        account.state !== 'DEPLOYED'
    ) {

        await account.deploy();

        await sleep(10000);
    }

    rpcConnection =
        account.getRPCConnection();

    await rpcConnection.connect();

    await rpcConnection.waitSynchronized();

    console.log('✅ MetaApi conectado');
}

/* =========================================================
   NUEVO DIA FTMO
========================================================= */

async function verificarNuevoDia() {

    const hoy =
        new Date()
            .toISOString()
            .split('T')[0];

    if (
        estadoBot.diaActual !== hoy
    ) {

        await sincronizarCuentaFTMO();

        estadoBot.diaActual = hoy;

        estadoBot.operacionesHoy = 0;

        estadoBot.operoHoyFTMO = false;

        estadoBot.limiteDiarioNotificado = false;

        estadoBot.balanceInicioDia =
            estadoBot.balance;

        estadoBot.perdidaDiariaActual = 0;

        await guardarEstado();

        await notificar(
            '🌅 Nuevo día FTMO'
        );
    }
}

/* =========================================================
   SINCRONIZAR FTMO REAL
========================================================= */

async function sincronizarCuentaFTMO() {

    const info =
        await rpcConnection
            .getAccountInformation();

    estadoBot.balance =
        Number(info.balance);

    estadoBot.equity =
        Number(info.equity);

    /* =========================================
       DD DIARIO REAL FTMO
       SOLO CUENTA PERDIDA DEL DIA
    ========================================= */

    const resultadoHoy =
        estadoBot.balance -
        estadoBot.balanceInicioDia;

    estadoBot.perdidaDiariaActual =
        resultadoHoy < 0
            ? Math.abs(resultadoHoy)
            : 0;

    /* =========================================
       DD TOTAL
    ========================================= */

    estadoBot.perdidaTotalActual =
        CAPITAL_INICIAL -
        estadoBot.balance;

    if (
        estadoBot.perdidaTotalActual < 0
    ) {
        estadoBot.perdidaTotalActual = 0;
    }

    await guardarEstado();
}

/* =========================================================
   LIMITES FTMO
========================================================= */

async function verificarLimitesFTMO() {

    if (
        estadoBot.perdidaDiariaActual >=
        LIMITE_DD_DIARIO
    ) {

        if (
            !estadoBot.limiteDiarioNotificado
        ) {

            estadoBot.limiteDiarioNotificado = true;

            await guardarEstado();

            await notificar(
`
🛑 LIMITE DIARIO FTMO

💎 Equity:
${estadoBot.equity.toFixed(2)}

📉 DD Diario:
-${estadoBot.perdidaDiariaActual.toFixed(2)}

⛔ Trading detenido
`
            );
        }

        return false;
    }

    if (
        estadoBot.perdidaTotalActual >=
        LIMITE_DD_TOTAL
    ) {

        await notificar(
`
🚨 LIMITE TOTAL FTMO

💰 Balance:
${estadoBot.balance.toFixed(2)}

📉 DD Total:
-${estadoBot.perdidaTotalActual.toFixed(2)}

⛔ Trading detenido
`
        );

        return false;
    }

    return true;
}

/* =========================================================
   NOTICIAS
========================================================= */

async function detectarNoticiasFuertes() {

    const hora = horaUTC();

    const noticia =
        HORARIOS_NOTICIAS.includes(hora);

    if (
        noticia &&
        estadoBot.ultimaNoticia !== hora
    ) {

        estadoBot.ultimaNoticia = hora;

        estadoBot.pausaPorNoticias = true;

        estadoBot.pausaNoticiasHasta =
            Date.now() +
            (PAUSA_NOTICIAS_MINUTOS * 60 * 1000);

        await guardarEstado();

        await notificar(
`
📰 NOTICIA FUERTE

⛔ Trading pausado
`
        );
    }

    if (
        estadoBot.pausaPorNoticias &&
        Date.now() >
        estadoBot.pausaNoticiasHasta
    ) {

        estadoBot.pausaPorNoticias = false;

        estadoBot.pausaNoticiasHasta = 0;

        await guardarEstado();

        await notificar(
            '✅ Trading reactivado'
        );
    }
}

/* =========================================================
   SPREAD
========================================================= */

async function validarSpread() {

    const precio =
        await rpcConnection
            .getSymbolPrice(SYMBOL);

    const spread =
        Math.abs(
            precio.ask -
            precio.bid
        );

    console.log(
        `📊 Spread: ${spread}`
    );

    return spread <= MAX_SPREAD;
}

/* =========================================================
   VELAS
========================================================= */

async function obtenerVelas() {

    try {

        const account =
            await metaApi
                .metatraderAccountApi
                .getAccount(
                    META_API_ACCOUNT_ID
                );

        const candles =
            await account
                .getHistoricalCandles(
                    SYMBOL,
                    TIMEFRAME,
                    new Date(),
                    300
                );

        return candles.map((c: any) => ({

            open: Number(c.open),

            high: Number(c.high),

            low: Number(c.low),

            close: Number(c.close)

        }));

    } catch (error) {

        console.error(
            '❌ Velas:',
            error
        );

        return [];
    }
}

/* =========================================================
   SINCRONIZAR POSICIONES
========================================================= */

async function sincronizarPosiciones() {

    const posiciones =
        await rpcConnection
            .getPositions();

    if (
        posiciones.length > 0
    ) {

        const p = posiciones[0];

        estadoBot.enPosicion = true;

        estadoBot.tipo =
            p.type ===
            'POSITION_TYPE_BUY'
                ? 'LONG'
                : 'SHORT';

        estadoBot.precioEntrada =
            Number(p.openPrice);

        estadoBot.stopLoss =
            Number(p.stopLoss || 0);

        estadoBot.takeProfit =
            Number(p.takeProfit || 0);

        estadoBot.lotes =
            Number(p.volume);

        estadoBot.ticket = p.id;

    } else {

        /* =====================================
           SI YA NO HAY POSICION EN FTMO
           LIMPIAR ESTADO LOCAL
        ===================================== */

        if (
            estadoBot.enPosicion
        ) {

            await notificar(
                '✅ Operación finalizada'
            );
        }

        estadoBot.enPosicion = false;

        estadoBot.tipo = 'NINGUNA';

        estadoBot.ticket = null;

        estadoBot.breakEvenActivado = false;

        estadoBot.precioEntrada = 0;

        estadoBot.stopLoss = 0;

        estadoBot.takeProfit = 0;

        estadoBot.lotes = 0;
    }

    await guardarEstado();
}

/* =========================================================
   LOTES
========================================================= */

async function calcularLotes(
    distanciaSL: number
) {

    const spec =
        await rpcConnection
            .getSymbolSpecification(
                SYMBOL
            );

    const contractSize =
        Number(
            spec.contractSize || 1
        );

    const riesgoUSD =
        estadoBot.balance *
        RIESGO_POR_OPERACION;

    let lotes =
        riesgoUSD /
        (
            distanciaSL *
            contractSize
        );

    if (lotes > 1) {
        lotes = 1;
    }

    if (lotes < 0.01) {
        lotes = 0.01;
    }

    return Number(
        lotes.toFixed(2)
    );
}

/* =========================================================
   BREAK EVEN
========================================================= */

async function moverBreakEven() {

    if (
        !estadoBot.enPosicion ||
        estadoBot.breakEvenActivado ||
        !estadoBot.ticket
    ) return;

    const precio =
        await rpcConnection
            .getSymbolPrice(
                SYMBOL
            );

    const actual = precio.bid;

    const avance =
        Math.abs(
            actual -
            estadoBot.precioEntrada
        );

    const objetivo =
        Math.abs(
            estadoBot.takeProfit -
            estadoBot.precioEntrada
        );

    if (
        avance >=
        (objetivo * 0.5)
    ) {

        await rpcConnection
            .modifyPosition(
                estadoBot.ticket,
                estadoBot.precioEntrada,
                estadoBot.takeProfit
            );

        estadoBot.stopLoss =
            estadoBot.precioEntrada;

        estadoBot.breakEvenActivado = true;

        await guardarEstado();

        await notificar(
            '🔒 BreakEven activado'
        );
    }
}

/* =========================================================
   ORDENES
========================================================= */

async function abrirOperacion(
    tipo: 'BUY' | 'SELL',
    lotes: number,
    sl: number,
    tp: number
) {

    try {

        if (tipo === 'BUY') {

            return await rpcConnection
                .createMarketBuyOrder(
                    SYMBOL,
                    lotes,
                    sl,
                    tp
                );
        }

        return await rpcConnection
            .createMarketSellOrder(
                SYMBOL,
                lotes,
                sl,
                tp
            );

    } catch (error) {

        console.error(
            '❌ Orden:',
            error
        );

        return null;
    }
}

/* =========================================================
   CONSOLIDACION
========================================================= */

function detectarConsolidacion(
    highs: number[],
    lows: number[]
) {

    const rangoHigh =
        Math.max(
            ...highs.slice(
                -VELAS_CONSOLIDACION
            )
        );

    const rangoLow =
        Math.min(
            ...lows.slice(
                -VELAS_CONSOLIDACION
            )
        );

    const rango =
        rangoHigh - rangoLow;

    return rango < 150;
}

/* =========================================================
   TELEGRAM
========================================================= */

bot.onText(/\/estado/, async () => {

    await sincronizarCuentaFTMO();

    await sincronizarPosiciones();

    const resultadoHoy =
        estadoBot.balance -
        estadoBot.balanceInicioDia;

    await notificar(
`
📊 BOT FTMO V18

📌 Posición:
${estadoBot.tipo}

💰 Balance:
${estadoBot.balance.toFixed(2)}

💎 Equity:
${estadoBot.equity.toFixed(2)}

📈 Resultado Hoy:
${resultadoHoy.toFixed(2)}

📉 DD Diario:
-${estadoBot.perdidaDiariaActual.toFixed(2)}

📉 DD Total:
-${estadoBot.perdidaTotalActual.toFixed(2)}

📊 Operaciones:
${estadoBot.operacionesHoy}

🔒 BreakEven:
${estadoBot.breakEvenActivado}

📰 Noticias:
${estadoBot.pausaPorNoticias ? 'SI' : 'NO'}

🤖 Pausado:
${botPausado ? 'SI' : 'NO'}
`
    );
});

/* =========================================================
   COMANDOS
========================================================= */

bot.onText(/\/pausa/, async () => {

    botPausado = true;

    await guardarEstado();

    await notificar(
        '⛔ BOT PAUSADO'
    );
});

bot.onText(/\/reinicio/, async () => {

    botPausado = false;

    await guardarEstado();

    await notificar(
        '✅ BOT REACTIVADO'
    );
});

bot.onText(/\/cerrar/, async () => {

    const posiciones =
        await rpcConnection
            .getPositions();

    for (const p of posiciones) {

        await rpcConnection
            .closePosition(
                p.id
            );
    }

    await sincronizarPosiciones();

    await notificar(
        '🛑 Posiciones cerradas'
    );
});

/* =========================================================
   ANALISIS
========================================================= */

async function analizarMercado() {

    if (
        analizando ||
        botPausado
    ) return;

    analizando = true;

    try {

        await sincronizarCuentaFTMO();

        await sincronizarPosiciones();

        await detectarNoticiasFuertes();

        if (
            estadoBot.pausaPorNoticias
        ) return;

        if (
            esFinDeSemana()
        ) return;

        await verificarNuevoDia();

        const permitido =
            await verificarLimitesFTMO();

        if (!permitido) return;

        if (
            estadoBot.enPosicion
        ) {

            await moverBreakEven();

            return;
        }

        if (
            estadoBot.operacionesHoy >=
            MAX_OPERACIONES_DIA
        ) return;

        const spreadOk =
            await validarSpread();

        if (!spreadOk) return;

        const velas =
            await obtenerVelas();

        if (
            velas.length < 250
        ) return;

        const cerradas =
            velas.slice(0, -1);

        const closes =
            cerradas.map(v => v.close);

        const highs =
            cerradas.map(v => v.high);

        const lows =
            cerradas.map(v => v.low);

        const precioActual =
            closes[closes.length - 1];

        const resistencia =
            Math.max(
                ...highs.slice(
                    -VELAS_SOPORTE_RESISTENCIA
                )
            );

        const soporte =
            Math.min(
                ...lows.slice(
                    -VELAS_SOPORTE_RESISTENCIA
                )
            );

        const consolidando =
            detectarConsolidacion(
                highs,
                lows
            );

        if (consolidando) {

            console.log(
                '📦 Consolidación'
            );

            return;
        }

        const sma200 =
            SMA.calculate({
                period: 200,
                values: closes
            }).pop();

        const rsi =
            RSI.calculate({
                period: 14,
                values: closes
            }).pop();

        const adx =
            ADX.calculate({
                close: closes,
                high: highs,
                low: lows,
                period: 14
            }).pop();

        const atr =
            ATR.calculate({
                high: highs,
                low: lows,
                close: closes,
                period: 14
            }).pop();

        const macd =
            MACD.calculate({
                values: closes,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            }).pop();

        if (
            !sma200 ||
            !rsi ||
            !adx ||
            !atr ||
            !macd
        ) return;

        if (
            adx.adx < MIN_ADX
        ) return;

        if (
            atr < MIN_ATR
        ) return;

        const ultimaVela =
            cerradas[cerradas.length - 1];

        const cuerpo =
            Math.abs(
                ultimaVela.close -
                ultimaVela.open
            );

        const rango =
            ultimaVela.high -
            ultimaVela.low;

        const mechaSuperior =
            ultimaVela.high -
            Math.max(
                ultimaVela.open,
                ultimaVela.close
            );

        const mechaInferior =
            Math.min(
                ultimaVela.open,
                ultimaVela.close
            ) -
            ultimaVela.low;

        const velaAlcista =
            ultimaVela.close >
            ultimaVela.open;

        const velaBajista =
            ultimaVela.close <
            ultimaVela.open;

        const fuerzaAlcista =
            velaAlcista &&
            cuerpo > (rango * 0.5) &&
            mechaSuperior < cuerpo;

        const fuerzaBajista =
            velaBajista &&
            cuerpo > (rango * 0.5) &&
            mechaInferior < cuerpo;

        /* =====================================
           LONG
        ===================================== */

        if (

            precioActual > sma200 &&

            precioActual >= resistencia &&

            macd.MACD! >
            macd.signal! &&

            rsi < 70 &&

            fuerzaAlcista

        ) {

            const sl =
                precioActual -
                (
                    atr *
                    ATR_MULTIPLICADOR_SL
                );

            const tp =
                precioActual +
                (
                    atr *
                    ATR_MULTIPLICADOR_TP
                );

            const distanciaSL =
                Math.abs(
                    precioActual - sl
                );

            const lotes =
                await calcularLotes(
                    distanciaSL
                );

            const orden =
                await abrirOperacion(
                    'BUY',
                    lotes,
                    sl,
                    tp
                );

            if (!orden) return;

            estadoBot.enPosicion = true;

            estadoBot.tipo = 'LONG';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss = sl;

            estadoBot.takeProfit = tp;

            estadoBot.ticket =
                orden.positionId;

            estadoBot.lotes = lotes;

            estadoBot.operacionesHoy++;

            await guardarEstado();

            await notificar(
`
🚀 LONG BTCUSD

📍 Entrada:
${precioActual}

🛑 SL:
${sl}

🎯 TP:
${tp}

📦 Lotes:
${lotes}
`
            );
        }

        /* =====================================
           SHORT
        ===================================== */

        else if (

            precioActual < sma200 &&

            precioActual <= soporte &&

            macd.MACD! <
            macd.signal! &&

            rsi > 30 &&

            fuerzaBajista

        ) {

            const sl =
                precioActual +
                (
                    atr *
                    ATR_MULTIPLICADOR_SL
                );

            const tp =
                precioActual -
                (
                    atr *
                    ATR_MULTIPLICADOR_TP
                );

            const distanciaSL =
                Math.abs(
                    sl - precioActual
                );

            const lotes =
                await calcularLotes(
                    distanciaSL
                );

            const orden =
                await abrirOperacion(
                    'SELL',
                    lotes,
                    sl,
                    tp
                );

            if (!orden) return;

            estadoBot.enPosicion = true;

            estadoBot.tipo = 'SHORT';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss = sl;

            estadoBot.takeProfit = tp;

            estadoBot.ticket =
                orden.positionId;

            estadoBot.lotes = lotes;

            estadoBot.operacionesHoy++;

            await guardarEstado();

            await notificar(
`
📉 SHORT BTCUSD

📍 Entrada:
${precioActual}

🛑 SL:
${sl}

🎯 TP:
${tp}

📦 Lotes:
${lotes}
`
            );
        }

    } catch (error) {

        console.error(
            '❌ Error análisis:',
            error
        );

    } finally {

        analizando = false;
    }
}

/* =========================================================
   LOOP
========================================================= */

async function loopPrincipal() {

    while (true) {

        try {

            await analizarMercado();

        } catch (error) {

            console.error(
                '❌ Loop:',
                error
            );
        }

        await sleep(
            LOOP_ANALISIS_MS
        );
    }
}

/* =========================================================
   START
========================================================= */

async function start() {

    console.log(
        '🚀 BOT FTMO V18'
    );

    await conectarMongo();

    await conectarMetaApi();

    await sincronizarCuentaFTMO();

    await sincronizarPosiciones();

    await verificarNuevoDia();

    await guardarEstado();

    await notificar(
        '🛡️ BOT FTMO V18 ONLINE'
    );

    await loopPrincipal();
}

start().catch(console.error);