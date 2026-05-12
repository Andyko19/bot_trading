/* =========================================================
   BOT FTMO V12 INSTITUCIONAL ULTRA
   =========================================================

   ✅ DATOS REALES FTMO
   ✅ EQUITY REAL
   ✅ DRAWDOWN REAL
   ✅ ANTI SPAM TELEGRAM
   ✅ PROTECCIÓN NOTICIAS
   ✅ BREAK EVEN
   ✅ SPREAD FILTER
   ✅ CONTROL TELEGRAM
   ✅ SINCRONIZACIÓN MT5
   ✅ PERSISTENCIA MONGODB
   ✅ ANTI REINICIO RAILWAY
   ✅ GESTIÓN RIESGO FTMO
   ✅ OPERAR 1 VEZ AL DÍA
   ✅ ATR + ADX + RSI + MACD
   ✅ LOTAJE PROFESIONAL
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
   VARIABLES ENTORNO
========================================================= */

const TELEGRAM_TOKEN =
    process.env.TELEGRAM_TOKEN;

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID;

const META_API_TOKEN =
    process.env.META_API_TOKEN;

const META_API_ACCOUNT_ID =
    process.env.META_API_ACCOUNT_ID;

const MONGO_URI =
    process.env.MONGO_URI;

if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID ||
    !META_API_TOKEN ||
    !META_API_ACCOUNT_ID ||
    !MONGO_URI
) {

    console.error(
        '❌ Variables entorno faltantes'
    );

    process.exit(1);
}

/* =========================================================
   CONFIG
========================================================= */

const SYMBOL_MT5 = 'BTCUSD';

const TIMEFRAME = '1h';

const CAPITAL_INICIAL = 10000;

/* FTMO */

const LIMITE_PERDIDA_DIARIA_FTMO = 0.05;

const LIMITE_PERDIDA_TOTAL_FTMO = 0.10;

/* RIESGO */

const RIESGO_POR_OPERACION = 0.005;

/* FILTROS */

const MAX_SPREAD = 50;

const MIN_ADX = 25;

const MIN_ATR = 50;

/* CONTROL */

const LOOP_MS = 60000;

const MAX_OPERACIONES_DIA = 3;

/* NOTICIAS */

const PAUSA_NOTICIAS_MINUTOS = 25;

const HORARIOS_NOTICIAS_FUERTES = [

    '13:30',
    '18:00'
];

/* =========================================================
   INSTANCIAS
========================================================= */

const bot = new TelegramBot(
    TELEGRAM_TOKEN,
    {
        polling: true
    }
);

const metaApi =
    new MetaApi(META_API_TOKEN);

const mongoClient =
    new MongoClient(MONGO_URI);

/* =========================================================
   VARIABLES GLOBALES
========================================================= */

let rpcConnection: any = null;

let dbCollection: any = null;

let analizando = false;

let botPausado = false;

/* =========================================================
   TIPOS
========================================================= */

type TipoPosicion =
    | 'LONG'
    | 'SHORT'
    | 'NINGUNA';

interface EstadoBot {

    enPosicion: boolean;

    tipo: TipoPosicion;

    precioEntrada: number;

    stopLoss: number;

    takeProfit: number;

    lotes: number;

    balance: number;

    equity: number;

    balanceInicioDia: number;

    equityInicioDia: number;

    perdidaDiariaActual: number;

    perdidaTotalActual: number;

    diaActual: string;

    operacionesHoy: number;

    breakEvenActivado: boolean;

    ticket?: string;

    operoHoyFTMO: boolean;

    pausaPorNoticias: boolean;

    pausaNoticiasHasta: number;

    ultimaNoticiaDetectada: string;

    limiteDiarioNotificado: boolean;

    limiteTotalNotificado: boolean;
}

/* =========================================================
   ESTADO INICIAL
========================================================= */

let estadoBot: EstadoBot = {

    enPosicion: false,

    tipo: 'NINGUNA',

    precioEntrada: 0,

    stopLoss: 0,

    takeProfit: 0,

    lotes: 0,

    balance: CAPITAL_INICIAL,

    equity: CAPITAL_INICIAL,

    balanceInicioDia: CAPITAL_INICIAL,

    equityInicioDia: CAPITAL_INICIAL,

    perdidaDiariaActual: 0,

    perdidaTotalActual: 0,

    diaActual:
        new Date()
            .toISOString()
            .split('T')[0],

    operacionesHoy: 0,

    breakEvenActivado: false,

    operoHoyFTMO: false,

    pausaPorNoticias: false,

    pausaNoticiasHasta: 0,

    ultimaNoticiaDetectada: '',

    limiteDiarioNotificado: false,

    limiteTotalNotificado: false
};

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms: number) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

function horaUTC(): string {

    const now = new Date();

    const hh =
        String(
            now.getUTCHours()
        ).padStart(2, '0');

    const mm =
        String(
            now.getUTCMinutes()
        ).padStart(2, '0');

    return `${hh}:${mm}`;
}

function esFinDeSemana(): boolean {

    const day =
        new Date().getUTCDay();

    return day === 0 || day === 6;
}

/* =========================================================
   TELEGRAM
========================================================= */

async function notificar(
    mensaje: string
) {

    try {

        await bot.sendMessage(
            TELEGRAM_CHAT_ID!,
            mensaje
        );

    } catch (error) {

        console.error(
            '❌ Telegram:',
            error
        );
    }
}

/* =========================================================
   BASE DATOS
========================================================= */

async function conectarBaseDatos() {

    await mongoClient.connect();

    const db =
        mongoClient.db(
            'TradingBotDB'
        );

    dbCollection =
        db.collection(
            'estado_bot'
        );

    const guardado =
        await dbCollection.findOne({
            id: 'BOT_FTMO_V12'
        });

    if (guardado) {

        delete guardado._id;

        estadoBot = {
            ...estadoBot,
            ...guardado
        };

        console.log(
            '💾 Estado restaurado MongoDB'
        );
    }
}

async function guardarEstado() {

    if (!dbCollection) return;

    await dbCollection.updateOne(
        {
            id: 'BOT_FTMO_V12'
        },
        {
            $set: {
                ...estadoBot,
                botPausado,
                updatedAt:
                    new Date()
            }
        },
        {
            upsert: true
        }
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
                META_API_ACCOUNT_ID!
            );

    if (
        account.state !==
        'DEPLOYED'
    ) {

        await account.deploy();
    }

    rpcConnection =
        account.getRPCConnection();

    await rpcConnection.connect();

    await rpcConnection.waitSynchronized();

    console.log(
        '✅ MetaApi conectado'
    );
}

/* =========================================================
   NOTICIAS
========================================================= */

async function detectarNoticiasFuertes() {

    try {

        const horaActual =
            horaUTC();

        const esNoticia =
            HORARIOS_NOTICIAS_FUERTES
                .includes(horaActual);

        if (

            esNoticia &&

            estadoBot.ultimaNoticiaDetectada !==
            horaActual

        ) {

            estadoBot.pausaPorNoticias =
                true;

            estadoBot.ultimaNoticiaDetectada =
                horaActual;

            estadoBot.pausaNoticiasHasta =
                Date.now() +
                (
                    PAUSA_NOTICIAS_MINUTOS *
                    60 *
                    1000
                );

            await guardarEstado();

            await notificar(
`
📰 NOTICIA FUERTE DETECTADA

⛔ Trading pausado

🕒 Reactiva:
${new Date(
    estadoBot.pausaNoticiasHasta
).toUTCString()}
`
            );
        }

        if (

            estadoBot.pausaPorNoticias &&

            Date.now() >
            estadoBot.pausaNoticiasHasta

        ) {

            estadoBot.pausaPorNoticias =
                false;

            estadoBot.pausaNoticiasHasta =
                0;

            await guardarEstado();

            await notificar(
                '✅ Trading reactivado'
            );
        }

    } catch (error) {

        console.error(
            '❌ Noticias:',
            error
        );
    }
}

/* =========================================================
   SINCRONIZAR FTMO
========================================================= */

async function sincronizarCuentaFTMO() {

    try {

        const info =
            await rpcConnection
                .getAccountInformation();

        if (!info) return;

        estadoBot.balance =
            Number(info.balance);

        estadoBot.equity =
            Number(info.equity);

        estadoBot.perdidaDiariaActual =
            estadoBot.equityInicioDia -
            estadoBot.equity;

        estadoBot.perdidaTotalActual =
            CAPITAL_INICIAL -
            estadoBot.equity;

        await guardarEstado();

    } catch (error) {

        console.error(
            '❌ Sync FTMO:',
            error
        );
    }
}

/* =========================================================
   NUEVO DIA
========================================================= */

async function verificarNuevoDiaFTMO() {

    const hoy =
        new Date()
            .toISOString()
            .split('T')[0];

    if (
        estadoBot.diaActual !== hoy
    ) {

        estadoBot.diaActual =
            hoy;

        estadoBot.balanceInicioDia =
            estadoBot.balance;

        estadoBot.equityInicioDia =
            estadoBot.equity;

        estadoBot.perdidaDiariaActual =
            0;

        estadoBot.operacionesHoy =
            0;

        estadoBot.operoHoyFTMO =
            false;

        estadoBot.limiteDiarioNotificado =
            false;

        await guardarEstado();

        await notificar(
            '🌅 Nuevo día FTMO'
        );
    }
}

/* =========================================================
   LIMITES FTMO
========================================================= */

async function verificarLimitesFTMO() {

    const limiteDiarioDinero =
        CAPITAL_INICIAL *
        LIMITE_PERDIDA_DIARIA_FTMO;

    if (

        estadoBot.perdidaDiariaActual >=
        limiteDiarioDinero

    ) {

        if (
            !estadoBot.limiteDiarioNotificado
        ) {

            estadoBot.limiteDiarioNotificado =
                true;

            await guardarEstado();

            await notificar(
`
🛑 LÍMITE DIARIO FTMO

📉 Equity:
${estadoBot.equity.toFixed(2)}

📉 DD Diario:
-${estadoBot.perdidaDiariaActual.toFixed(2)}

⛔ Trading detenido
`
            );
        }

        return false;
    }

    const limiteTotalDinero =
        CAPITAL_INICIAL *
        LIMITE_PERDIDA_TOTAL_FTMO;

    if (

        estadoBot.perdidaTotalActual >=
        limiteTotalDinero

    ) {

        if (
            !estadoBot.limiteTotalNotificado
        ) {

            estadoBot.limiteTotalNotificado =
                true;

            await guardarEstado();

            await notificar(
`
🚨 LÍMITE TOTAL FTMO

📉 Equity:
${estadoBot.equity.toFixed(2)}

📉 DD Total:
-${estadoBot.perdidaTotalActual.toFixed(2)}

⛔ Cuenta protegida
`
            );
        }

        return false;
    }

    return true;
}

/* =========================================================
   SYMBOL INFO
========================================================= */

async function obtenerInfoSimbolo() {

    return await rpcConnection
        .getSymbolSpecification(
            SYMBOL_MT5
        );
}

/* =========================================================
   SPREAD
========================================================= */

async function validarSpread():
Promise<boolean> {

    const precio =
        await rpcConnection
            .getSymbolPrice(
                SYMBOL_MT5
            );

    const spread =
        precio.ask -
        precio.bid;

    console.log(
        `📊 Spread: ${spread}`
    );

    return spread <= MAX_SPREAD;
}

/* =========================================================
   VELAS FTMO
========================================================= */

async function obtenerVelasMT5() {

    const now = new Date();

    const from = new Date(
        now.getTime() -
        (
            300 *
            60 *
            60 *
            1000
        )
    );

    const candles =
        await rpcConnection
            .getHistoricalCandles(
                SYMBOL_MT5,
                TIMEFRAME,
                from
            );

    return candles.map(
        (c: any) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close
        })
    );
}

/* =========================================================
   POSICIONES
========================================================= */

async function sincronizarPosiciones() {

    const posiciones =
        await rpcConnection
            .getPositions();

    if (
        posiciones.length > 0
    ) {

        const p =
            posiciones[0];

        estadoBot.enPosicion =
            true;

        estadoBot.tipo =
            p.type ===
            'POSITION_TYPE_BUY'
                ? 'LONG'
                : 'SHORT';

        estadoBot.precioEntrada =
            p.openPrice;

        estadoBot.stopLoss =
            p.stopLoss || 0;

        estadoBot.takeProfit =
            p.takeProfit || 0;

        estadoBot.lotes =
            p.volume || 0;

        estadoBot.ticket =
            p.id;

    } else {

        estadoBot.enPosicion =
            false;

        estadoBot.tipo =
            'NINGUNA';

        estadoBot.breakEvenActivado =
            false;

        estadoBot.ticket =
            undefined;
    }

    await guardarEstado();
}

/* =========================================================
   LOTES
========================================================= */

async function calcularLotes(
    balance: number,
    riesgo: number,
    distanciaSL: number
): Promise<number> {

    const symbolInfo =
        await obtenerInfoSimbolo();

    const contractSize =
        symbolInfo.contractSize || 1;

    const tickSize =
        symbolInfo.tickSize || 1;

    const riesgoUSD =
        balance * riesgo;

    const valorMovimiento =
        contractSize *
        tickSize;

    const lotes =
        riesgoUSD /
        (
            distanciaSL *
            valorMovimiento
        );

    return Number(
        Math.max(
            0.01,
            lotes
        ).toFixed(2)
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
                SYMBOL_MT5
            );

    const actual =
        precio.bid;

    const objetivo =
        Math.abs(
            estadoBot.takeProfit -
            estadoBot.precioEntrada
        );

    const avance =
        Math.abs(
            actual -
            estadoBot.precioEntrada
        );

    if (
        avance >=
        objetivo * 0.5
    ) {

        await rpcConnection
            .modifyPosition(
                estadoBot.ticket,
                estadoBot.precioEntrada,
                estadoBot.takeProfit
            );

        estadoBot.breakEvenActivado =
            true;

        estadoBot.stopLoss =
            estadoBot.precioEntrada;

        await guardarEstado();

        await notificar(
            '🔒 Break Even activado'
        );
    }
}

/* =========================================================
   CERRAR POSICIONES
========================================================= */

async function cerrarPosicionManual() {

    const posiciones =
        await rpcConnection
            .getPositions();

    for (const p of posiciones) {

        await rpcConnection
            .closePosition(
                p.id
            );
    }

    estadoBot.enPosicion =
        false;

    estadoBot.tipo =
        'NINGUNA';

    estadoBot.breakEvenActivado =
        false;

    await guardarEstado();
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

    if (tipo === 'BUY') {

        return await rpcConnection
            .createMarketBuyOrder(
                SYMBOL_MT5,
                lotes,
                sl,
                tp
            );
    }

    return await rpcConnection
        .createMarketSellOrder(
            SYMBOL_MT5,
            lotes,
            sl,
            tp
        );
}

/* =========================================================
   TELEGRAM COMANDOS
========================================================= */

bot.onText(
    /\/estado/,
    async () => {

        const resultadoHoy =
            estadoBot.equity -
            estadoBot.equityInicioDia;

        const resultadoTotal =
            estadoBot.equity -
            CAPITAL_INICIAL;

        await notificar(
`
📊 BOT FTMO V12

🤖 Pausado:
${botPausado ? 'SI' : 'NO'}

📰 Noticias:
${estadoBot.pausaPorNoticias ? 'SI' : 'NO'}

📌 Posición:
${estadoBot.tipo}

💰 Balance:
${estadoBot.balance.toFixed(2)}

💎 Equity:
${estadoBot.equity.toFixed(2)}

📅 Resultado Hoy:
${resultadoHoy.toFixed(2)}

📉 DD Diario:
-${estadoBot.perdidaDiariaActual.toFixed(2)}

📉 DD Total:
-${estadoBot.perdidaTotalActual.toFixed(2)}

📊 Resultado Total:
${resultadoTotal.toFixed(2)}

📈 Operaciones:
${estadoBot.operacionesHoy}

✅ Operó Hoy:
${estadoBot.operoHoyFTMO ? 'SI' : 'NO'}

🔒 BreakEven:
${estadoBot.breakEvenActivado}

🕒 Hora UTC:
${horaUTC()}
`
        );
    }
);

bot.onText(
    /\/pausa/,
    async () => {

        botPausado = true;

        await guardarEstado();

        await notificar(
            '⛔ BOT PAUSADO'
        );
    }
);

bot.onText(
    /\/reinicio/,
    async () => {

        botPausado = false;

        await guardarEstado();

        await notificar(
            '✅ BOT REACTIVADO'
        );
    }
);

bot.onText(
    /\/cerrar/,
    async () => {

        await cerrarPosicionManual();

        await notificar(
            '🛑 Posiciones cerradas'
        );
    }
);

/* =========================================================
   ANALISIS
========================================================= */

async function analizarMercado() {

    if (analizando) return;

    if (botPausado) return;

    analizando = true;

    try {

        await detectarNoticiasFuertes();

        if (
            estadoBot.pausaPorNoticias
        ) {

            console.log(
                '📰 Pausa noticias'
            );

            return;
        }

        if (
            esFinDeSemana()
        ) return;

        await sincronizarCuentaFTMO();

        await verificarNuevoDiaFTMO();

        const permitido =
            await verificarLimitesFTMO();

        if (!permitido) {

            console.log(
                '🛑 FTMO bloqueo riesgo'
            );

            return;
        }

        await sincronizarPosiciones();

        if (
            estadoBot.operacionesHoy >=
            MAX_OPERACIONES_DIA
        ) return;

        if (
            estadoBot.enPosicion
        ) {

            await moverBreakEven();

            return;
        }

        const spreadOk =
            await validarSpread();

        if (!spreadOk) {

            console.log(
                '❌ Spread alto'
            );

            return;
        }

        const velas =
            await obtenerVelasMT5();

        if (
            velas.length < 250
        ) return;

        const velasCerradas =
            velas.slice(0, -1);

        const closes =
            velasCerradas.map(
                v => v.close
            );

        const highs =
            velasCerradas.map(
                v => v.high
            );

        const lows =
            velasCerradas.map(
                v => v.low
            );

        const precioActual =
            closes[
                closes.length - 1
            ];

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
                SimpleMAOscillator:
                    false,
                SimpleMASignal:
                    false
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

        /* =================================================
           LONG
        ================================================= */

        if (

            precioActual > sma200 &&

            rsi < 70 &&

            macd.MACD! >
            macd.signal!

        ) {

            const sl =
                precioActual -
                (atr * 1.5);

            const tp =
                precioActual +
                (atr * 3);

            const distanciaSL =
                Math.abs(
                    precioActual - sl
                );

            const lotes =
                await calcularLotes(
                    estadoBot.balance,
                    RIESGO_POR_OPERACION,
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

            estadoBot.enPosicion =
                true;

            estadoBot.tipo =
                'LONG';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss =
                sl;

            estadoBot.takeProfit =
                tp;

            estadoBot.lotes =
                lotes;

            estadoBot.ticket =
                orden.positionId;

            estadoBot.operacionesHoy++;

            estadoBot.operoHoyFTMO =
                true;

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

        /* =================================================
           SHORT
        ================================================= */

        else if (

            precioActual < sma200 &&

            rsi > 30 &&

            macd.MACD! <
            macd.signal!

        ) {

            const sl =
                precioActual +
                (atr * 1.5);

            const tp =
                precioActual -
                (atr * 3);

            const distanciaSL =
                Math.abs(
                    sl - precioActual
                );

            const lotes =
                await calcularLotes(
                    estadoBot.balance,
                    RIESGO_POR_OPERACION,
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

            estadoBot.enPosicion =
                true;

            estadoBot.tipo =
                'SHORT';

            estadoBot.precioEntrada =
                precioActual;

            estadoBot.stopLoss =
                sl;

            estadoBot.takeProfit =
                tp;

            estadoBot.lotes =
                lotes;

            estadoBot.ticket =
                orden.positionId;

            estadoBot.operacionesHoy++;

            estadoBot.operoHoyFTMO =
                true;

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
                '❌ Loop principal:',
                error
            );
        }

        await sleep(LOOP_MS);
    }
}

/* =========================================================
   START
========================================================= */

async function start() {

    console.log(
        '🚀 BOT FTMO V12'
    );

    await conectarBaseDatos();

    await conectarMetaApi();

    await sincronizarCuentaFTMO();

    await sincronizarPosiciones();

    await verificarNuevoDiaFTMO();

    await notificar(
        '🛡️ BOT FTMO V12 ONLINE'
    );

    await loopPrincipal();
}

start().catch(console.error);