import dotenv from 'dotenv';
import * as MetaApiModule from 'metaapi.cloud-sdk';
import { MongoClient } from 'mongodb';
import { TelegramService } from './telegram';
import { SmcStrategy, Candle } from './estrategia';

dotenv.config();

const {
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    META_API_TOKEN,
    META_API_ACCOUNT_ID,
    MONGO_URI
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !META_API_TOKEN || !META_API_ACCOUNT_ID || !MONGO_URI) {
    console.error('❌ Error crítico: Faltan variables esenciales en el archivo .env');
    process.exit(1);
}

const SYMBOL = 'BTCUSD';
const TF_MAYOR = '4h';
const TF_ENTRADA = '15m';
const CAPITAL_EVALUACION = 10000;

const PROFIT_OBJETIVO_FASE1 = 1000;
const RISK_PER_TRADE = 0.005;
const FTMO_DIARIO_MAX_LOSS = 450;
const FTMO_TOTAL_MAX_LOSS = 900;
const MAX_OPERACIONES_DIA = 2;
const MAX_SPREAD_PUNTOS = 60;
const RR = 3;

function obtenerFechaFTMO(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Prague',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

let estadoBot = {
    enPosicion: false,
    tipo: 'NINGUNA' as 'LONG' | 'SHORT' | 'NINGUNA',
    precioEntrada: 0,
    stopLoss: 0,
    takeProfit: 0,
    lotes: 0,
    balance: CAPITAL_EVALUACION,
    equity: CAPITAL_EVALUACION,
    balanceInicioDia: CAPITAL_EVALUACION,
    perdidaDiariaActual: 0,
    perdidaTotalActual: 0,
    operacionesHoy: 0,
    breakEvenActivado: false,
    ticket: null as any,
    diaActual: obtenerFechaFTMO(),
    faseSuperada: false
};

const MetaApiClass: any = (MetaApiModule as any).default || MetaApiModule;
const metaApi = new MetaApiClass(META_API_TOKEN);
const mongoClient = new MongoClient(MONGO_URI);
const telegram = new TelegramService(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID);

let rpcConnection: any;
let dbCollection: any;
let analizando = false;

async function conectarConReintentos<T>(fn: () => Promise<T>, nombreModulo: string, maxIntentos = 5): Promise<T> {
    let tiempoEspera = 5000; 
    for (let intento = 1; intento <= maxIntentos; intento++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`⚠️ [Intento ${intento}/${maxIntentos}] Falló conexión con ${nombreModulo}.`);
            if (intento === maxIntentos) {
                const alerta = `🚨 *ERROR CRÍTICO:* No se pudo conectar a ${nombreModulo} tras ${maxIntentos} intentos.`;
                await telegram.enviarMensaje(alerta);
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, tiempoEspera));
            tiempoEspera *= 2; 
        }
    }
    throw new Error('Inalcanzable');
}

async function inicializarBaseDatos() {
    await mongoClient.connect();
    const db = mongoClient.db('TradingBotDB');
    dbCollection = db.collection('estado_v20');
    const guardado = await dbCollection.findOne({ id: 'BOT_REAL' });
    if (guardado) {
        delete guardado._id;
        estadoBot = { ...estadoBot, ...guardado };
        console.log('💾 [MongoDB] Estado previo restaurado correctamente.');
    }
}

async function inicializarMetaApi() {
    const account = await metaApi.metatraderAccountApi.getAccount(META_API_ACCOUNT_ID);
    if (account.state !== 'DEPLOYED') {
        await account.deploy();
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    rpcConnection = account.getRPCConnection();
    await rpcConnection.connect();
    await rpcConnection.waitSynchronized();
    console.log('✅ [MetaAPI] Terminal MT5 sincronizada.');
}

async function sincronizarMetricasFTMO() {
    const info = await rpcConnection.getAccountInformation();
    estadoBot.balance = Number(info.balance);
    estadoBot.equity = Number(info.equity);

    const baseCalculo = estadoBot.balanceInicioDia;
    const perdidaDia = baseCalculo - estadoBot.equity;
    estadoBot.perdidaDiariaActual = perdidaDia > 0 ? Number(perdidaDia.toFixed(2)) : 0;

    const perdidaTotal = CAPITAL_EVALUACION - estadoBot.equity;
    estadoBot.perdidaTotalActual = perdidaTotal > 0 ? Number(perdidaTotal.toFixed(2)) : 0;

    if ((estadoBot.balance - CAPITAL_EVALUACION) >= PROFIT_OBJETIVO_FASE1 && !estadoBot.faseSuperada) {
        estadoBot.faseSuperada = true;
        await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
        await telegram.enviarMensaje('🎉 🏆 *¡FASE 1 COMPLETADA!* Target del 10% alcanzado. Operativa pausada.');
    }
}

async function verificarCambioDeDia() {
    const fechaServidor = obtenerFechaFTMO();
    if (estadoBot.diaActual !== fechaServidor) {
        console.log(`🌅 Cambio de día FTMO detectado (${estadoBot.diaActual} -> ${fechaServidor})`);
        
        estadoBot.diaActual = fechaServidor;
        estadoBot.operacionesHoy = 0;
        estadoBot.balanceInicioDia = Math.max(estadoBot.balance, estadoBot.equity);
        estadoBot.perdidaDiariaActual = 0;

        await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
        await telegram.enviarMensaje('🌅 *Ciclo Diario FTMO Reiniciado:* Métricas de drawdown restablecidas.');
    }
}

async function calcularLotesSeguros(distanciaPrecioSL: number): Promise<number> {
    const riesgoUSD = estadoBot.balance * RISK_PER_TRADE;
    const spec = await rpcConnection.getSymbolSpecification(SYMBOL);

    const contractSize = Number(spec.contractSize) || 1;
    const minVol = spec.minVolume || 0.01;
    const maxVol = spec.maxVolume || 5.0;
    const step = spec.volumeStep || 0.01;

    let lotes = riesgoUSD / (distanciaPrecioSL * contractSize);
    const precisionStep = step.toString().split('.')[1]?.length || 2;
    lotes = Math.floor(lotes / step) * step;

    if (lotes < minVol) lotes = minVol;
    if (lotes > maxVol) lotes = maxVol;

    return Number(lotes.toFixed(precisionStep));
}

async function moverBreakEven() {
    if (!estadoBot.enPosicion || estadoBot.breakEvenActivado || !estadoBot.ticket) return;

    const precio = await rpcConnection.getSymbolPrice(SYMBOL);
    if (!precio) return;

    const actual = estadoBot.tipo === 'LONG' ? precio.bid : precio.ask;
    const avance = Math.abs(actual - estadoBot.precioEntrada);
    const objetivoTotal = Math.abs(estadoBot.takeProfit - estadoBot.precioEntrada);

    if (avance >= objetivoTotal * 0.5) {
        try {
            const buffer = estadoBot.precioEntrada * 0.0005;
            const nuevoSL = estadoBot.tipo === 'LONG' 
                ? Number((estadoBot.precioEntrada + buffer).toFixed(2))
                : Number((estadoBot.precioEntrada - buffer).toFixed(2));

            await rpcConnection.modifyPosition(estadoBot.ticket, nuevoSL, estadoBot.takeProfit);
            estadoBot.breakEvenActivado = true;
            estadoBot.stopLoss = nuevoSL;

            await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
            await telegram.enviarMensaje('🔒 *Break-Even Ejecutado:* Stop Loss reubicado por encima del punto de equilibrio.');
        } catch (error: any) {
            console.error('Error aplicando Break-Even:', error.message);
        }
    }
}

async function sincronizarEstatusPosiciones() {
    const posiciones = await rpcConnection.getPositions();
    if (posiciones && posiciones.length > 0) {
        const p = posiciones[0];
        estadoBot.enPosicion = true;
        estadoBot.tipo = p.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT';
        estadoBot.precioEntrada = Number(p.openPrice);
        estadoBot.ticket = p.id;
    } else {
        if (estadoBot.enPosicion) {
            await telegram.enviarMensaje('📉 *Aviso:* Posición cerrada en terminal MT5.');
        }
        estadoBot.enPosicion = false;
        estadoBot.tipo = 'NINGUNA';
        estadoBot.ticket = null;
        estadoBot.breakEvenActivado = false;
    }
    await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
}

async function obtenerVelasServidor(tf: string, limite: number): Promise<Candle[]> {
    try {
        const account = await metaApi.metatraderAccountApi.getAccount(META_API_ACCOUNT_ID);
        const candles = await account.getHistoricalCandles(SYMBOL, tf, new Date(), limite);
        return candles.map((c: any) => ({
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close)
        }));
    } catch (e: any) {
        console.error(`Error descargando velas ${tf}:`, e.message);
        return [];
    }
}

async function ejecutarCicloEstrategia() {
    if (analizando || estadoBot.faseSuperada) return;
    analizando = true;

    try {
        await sincronizarMetricasFTMO();
        await sincronizarEstatusPosiciones();
        await verificarCambioDeDia();

        if (estadoBot.perdidaDiariaActual >= FTMO_DIARIO_MAX_LOSS) {
            console.warn('🛑 Operativa pausada: Límite diario de seguridad alcanzado.');
            return;
        }
        if (estadoBot.perdidaTotalActual >= FTMO_TOTAL_MAX_LOSS) {
            console.warn('🛑 Operativa pausada: Límite total de seguridad alcanzado.');
            return;
        }

        if (estadoBot.enPosicion) {
            await moverBreakEven();
            return;
        }

        if (estadoBot.operacionesHoy >= MAX_OPERACIONES_DIA) {
            return;
        }

        const precio = await rpcConnection.getSymbolPrice(SYMBOL);
        if (!precio || typeof precio.ask !== 'number' || typeof precio.bid !== 'number') {
            return;
        }

        const spec = await rpcConnection.getSymbolSpecification(SYMBOL);
        const point = Number(spec.point) || 0.01;
        const spreadActual = Math.abs(precio.ask - precio.bid) / point;

        if (spreadActual > MAX_SPREAD_PUNTOS) {
            console.log(`Spread excesivo (${spreadActual.toFixed(1)} puntos). Entrada omitida.`);
            return;
        }

        const velas4H = await obtenerVelasServidor(TF_MAYOR, 40);
        const velas15m = await obtenerVelasServidor(TF_ENTRADA, 30);

        if (velas4H.length === 0 || velas15m.length === 0) return;

        const estructura = SmcStrategy.analizarEstructura4H(velas4H);
        const resultado = SmcStrategy.buscarEntrada(velas15m, estructura, RR);

        if (resultado.accion !== 'NINGUNA') {
            const precioEntradaReal = resultado.accion === 'LONG' ? precio.ask : precio.bid;
            const distanciaSL = Math.abs(precioEntradaReal - resultado.sl);

            if (distanciaSL <= 0) return;

            const lotesApropiados = await calcularLotesSeguros(distanciaSL);

            let ordenConfirmada;
            if (resultado.accion === 'LONG') {
                ordenConfirmada = await rpcConnection.createMarketBuyOrder(
                    SYMBOL, 
                    lotesApropiados, 
                    resultado.sl, 
                    resultado.tp
                );
            } else {
                ordenConfirmada = await rpcConnection.createMarketSellOrder(
                    SYMBOL, 
                    lotesApropiados, 
                    resultado.sl, 
                    resultado.tp
                );
            }

            if (ordenConfirmada) {
                estadoBot.enPosicion = true;
                estadoBot.tipo = resultado.accion;
                estadoBot.precioEntrada = precioEntradaReal;
                estadoBot.stopLoss = resultado.sl;
                estadoBot.takeProfit = resultado.tp;
                estadoBot.lotes = lotesApropiados;
                estadoBot.breakEvenActivado = false;
                estadoBot.ticket = ordenConfirmada.positionId || ordenConfirmada.orderId || ordenConfirmada.id;
                estadoBot.operacionesHoy++;

                await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });

                await telegram.enviarMensaje(`
🚀 *Operación Abierta en FTMO*
━━━━━━━━━━━━━━━━━━━━━━━━
🎯 *Activo:* ${SYMBOL}
🔹 *Dirección:* ${resultado.accion}
📍 *Entrada:* $${precioEntradaReal.toFixed(2)}
🛑 *Stop Loss:* $${resultado.sl.toFixed(2)}
🎯 *Take Profit:* $${resultado.tp.toFixed(2)}
📦 *Volumen:* ${lotesApropiados} Lotes
🧠 *Confluencia:* ${resultado.motivo}
━━━━━━━━━━━━━━━━━━━━━━━━
                `);
            }
        }
    } catch (e: any) {
        console.error('Error en el ciclo operativo:', e.message);
    } finally {
        analizando = false;
    }
}

function registrarComandosTelegram() {
    telegram.onComando(/\/estado/, async () => {
        await sincronizarMetricasFTMO();
        await sincronizarEstatusPosiciones();
        return `
📊 *ESTADO ACTUAL FTMO 10K*
━━━━━━━━━━━━━━━━━━━━━━━━
🤖 *Posición:* ${estadoBot.tipo} (${estadoBot.enPosicion ? 'ACTIVA' : 'NINGUNA'})
💰 *Balance:* $${estadoBot.balance.toFixed(2)}
💎 *Equity:* $${estadoBot.equity.toFixed(2)}
📉 *Pérdida Diaria:* $${estadoBot.perdidaDiariaActual.toFixed(2)} / $${FTMO_DIARIO_MAX_LOSS}
📉 *Pérdida Total:* $${estadoBot.perdidaTotalActual.toFixed(2)} / $${FTMO_TOTAL_MAX_LOSS}
⚡ *Trades Hoy:* ${estadoBot.operacionesHoy} / ${MAX_OPERACIONES_DIA}
🏆 *Objetivo Alcanzado:* ${estadoBot.faseSuperada ? 'SÍ' : 'NO'}
━━━━━━━━━━━━━━━━━━━━━━━━
        `;
    });
}

async function main() {
    console.log('🚀 Iniciando sistema algorítmico...');
    await conectarConReintentos(() => inicializarBaseDatos(), 'MongoDB');
    await conectarConReintentos(() => inicializarMetaApi(), 'MetaAPI Terminal');
    
    registrarComandosTelegram();
    await telegram.enviarMensaje('🛡️ *Bot FTMO v20 Activo:* Sistema conectado y sincronizado con Praga.');

    while (true) {
        await ejecutarCicloEstrategia();
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

main().catch(console.error);