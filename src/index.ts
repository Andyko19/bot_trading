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
    console.error('❌ Error crítico: Faltan variables esenciales en tu archivo .env');
    process.exit(1);
}

// CONFIGURACIÓN OPERATIVA NORMADA - REGLAS DE CUENTA FTMO DE $10,000
const SYMBOL = 'BTCUSD';
const TF_MAYOR = '4h';
const TF_ENTRADA = '15m';
const CAPITAL_EVALUACION = 10000;

const PROFT_OBJETIVO_FASE1 = 1000;    // 10% de objetivo
const RISK_PER_TRADE = 0.005;         // 0.5% por operación
const FTMO_DIARIO_MAX_LOSS = 450;     // Margen seguro (Límite real: 500)
const FTMO_TOTAL_MAX_LOSS = 900;      // Margen seguro (Límite real: 1000)
const MAX_OPERACIONES_DIA = 2;
const MAX_SPREAD_PUNTOS = 60;
const RR = 3; 

let estadoBot = {
    enPosicion: false,
    tipo: 'NINGUNA',
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
    diaActual: new Date().toISOString().split('T')[0],
    faseSuperada: false
};

const MetaApiClass: any = (MetaApiModule as any).default || MetaApiModule;
const metaApi = new MetaApiClass(META_API_TOKEN);
const mongoClient = new MongoClient(MONGO_URI);
const telegram = new TelegramService(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID);

let rpcConnection: any;
let dbCollection: any;
let analizando = false;

/* =========================================================
   SISTEMA DE SEGURIDAD CON REINTENTOS EXPONENCIALES
========================================================= */
async function conectarConReintentos<T>(fn: () => Promise<T>, nombreModulo: string, maxIntentos = 5): Promise<T> {
    let tiempoEspera = 5000; 
    for (let intento = 1; intento <= maxIntentos; intento++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`⚠️ [Intento ${intento}/${maxIntentos}] Falló la conexión con ${nombreModulo}.`);
            if (intento === maxIntentos) {
                const alerta = `🚨 *ERROR CRÍTICO INFRAESTRUCTURA:* El bot no se pudo conectar a ${nombreModulo} tras ${maxIntentos} intentos. Auto-apagado de emergencia activado para evitar bloqueos de API.`;
                await telegram.enviarMensaje(alerta);
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, tiempoEspera));
            tiempoEspera *= 2; 
        }
    }
    throw new Error('Inalcanzable');
}

/* =========================================================
   MÓDULOS DE CONEXIÓN
========================================================= */
async function inicializarBaseDatos() {
    await mongoClient.connect();
    const db = mongoClient.db('TradingBotDB');
    dbCollection = db.collection('estado_v20');
    const guardado = await dbCollection.findOne({ id: 'BOT_REAL' });
    if (guardado) {
        delete guardado._id;
        estadoBot = { ...estadoBot, ...guardado };
        console.log('💾 [MongoDB] Memoria restaurada correctamente.');
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
    console.log('✅ [MetaAPI] Terminal sincronizada y lista.');
}

/* =========================================================
   PROTECCIÓN DE DRAWDOWN Y MÓDULO FTMO
========================================================= */
async function sincronizarMetricasFTMO() {
    const info = await rpcConnection.getAccountInformation();
    estadoBot.balance = Number(info.balance);
    estadoBot.equity = Number(info.equity);

    const perdidaFlotante = estadoBot.balance - estadoBot.equity;
    const resultadoCerradoHoy = estadoBot.balance - estadoBot.balanceInicioDia;
    const drawdownRealDia = resultadoCerradoHoy - perdidaFlotante;

    estadoBot.perdidaDiariaActual = drawdownRealDia < 0 ? Math.abs(drawdownRealDia) : 0;
    estadoBot.perdidaTotalActual = CAPITAL_EVALUACION - estadoBot.equity;
    if (estadoBot.perdidaTotalActual < 0) estadoBot.perdidaTotalActual = 0;

    if ((estadoBot.balance - CAPITAL_EVALUACION) >= PROFT_OBJETIVO_FASE1 && !estadoBot.faseSuperada) {
        estadoBot.faseSuperada = true;
        await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
        await telegram.enviarMensaje('🎉 🏆 *¡OBJETIVO FTMO ALCANZADO!* El balance objetivo ha sido conquistado de forma segura. Operaciones congeladas para proteger tu pase de fase.');
    }
}

async function verificarCambioDeDia() {
    const hoy = new Date().toISOString().split('T')[0];
    if (estadoBot.diaActual !== hoy) {
        if (estadoBot.operacionesHoy === 0 && !estadoBot.enPosicion && !estadoBot.faseSuperada) {
            try {
                const spec = await rpcConnection.getSymbolSpecification(SYMBOL);
                const minVol = spec.minVolume || 0.01;
                const precio =
    await rpcConnection.getSymbolPrice(
        SYMBOL
    );

await rpcConnection.createMarketBuyOrder(
    SYMBOL,
    minVol,
    precio.bid - 100,
    precio.bid + 100
);
if (
    !precio ||
    !precio.ask ||
    !precio.bid
) {
    return;
}
                const ticketConsistencia = await rpcConnection.createMarketBuyOrder(SYMBOL, minVol, 0, 0);
                if (ticketConsistencia) {
                    await new Promise(resolve => setTimeout(resolve, 60000)); 
                    await rpcConnection.closePosition(ticketConsistencia.id);
                    console.log('🛡️ Trade mínimo de consistencia diario completado con éxito.');
                }
            } catch (e) {
                console.error('Error procesando trade de consistencia:', e);
            }
        }

        estadoBot.diaActual = hoy;
        estadoBot.operacionesHoy = 0;
        estadoBot.balanceInicioDia = estadoBot.balance;
        estadoBot.perdidaDiariaActual = 0;
        await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
        await telegram.enviarMensaje('🌅 *Nuevo ciclo diario financiero.* Parámetros de Drawdown restaurados.');
    }
}

/* =========================================================
   GESTIÓN DE RIESGO Y CONTROL DE VOLUMEN (LOTAJE)
========================================================= */
async function calcularLotesSeguros(distanciaPrecioSL: number): Promise<number> {
    const riesgoUSD = estadoBot.balance * RISK_PER_TRADE;

    const spec = await rpcConnection.getSymbolSpecification(SYMBOL);

    const tickValue = spec.tickValue || 1;
    const tickSize = spec.tickSize || 1;

    const valorMovimiento = tickValue / tickSize;

    let lotes =
        riesgoUSD /
        (distanciaPrecioSL * valorMovimiento);

    const minVol = spec.minVolume || 0.01;
    const maxVol = spec.maxVolume || 10.0;
    const step = spec.volumeStep || 0.01;

const LIMITE_MAX_LOTES = 1.0; 
    
    if (lotes < minVol) lotes = minVol;
    if (lotes > maxVol) lotes = maxVol;
    if (lotes > LIMITE_MAX_LOTES) lotes = LIMITE_MAX_LOTES; // <-- Nueva protección

    const lotesFinal =
    Number(
        (Math.round(lotes / step) * step)
        .toFixed(2)
    );

console.log('========== RIESGO ==========');
console.log('Balance:', estadoBot.balance);
console.log('Riesgo USD:', riesgoUSD);
console.log('Distancia SL:', distanciaPrecioSL);
console.log('TickValue:', tickValue);
console.log('TickSize:', tickSize);
console.log('Lotes Calculados:', lotesFinal);
console.log('============================');

return lotesFinal;
}

async function moverBreakEven() {
    if (!estadoBot.enPosicion || estadoBot.breakEvenActivado) return;

    const precio = await rpcConnection.getSymbolPrice(SYMBOL);

    const actual =
        estadoBot.tipo === 'LONG'
            ? precio.bid
            : precio.ask;

    const avance =
        Math.abs(actual - estadoBot.precioEntrada);

    const objetivoTotal =
        Math.abs(
            estadoBot.takeProfit -
            estadoBot.precioEntrada
        );

    if (avance >= objetivoTotal * 0.5) {
        try {

            const buffer =
    Math.abs(
        estadoBot.takeProfit -
        estadoBot.precioEntrada
    ) * 0.05;
    const nuevoSL = estadoBot.tipo === 'LONG' 
                ? estadoBot.precioEntrada + buffer 
                : estadoBot.precioEntrada - buffer;
            await rpcConnection.modifyPosition(
                estadoBot.ticket,
                
                nuevoSL,
                estadoBot.takeProfit
            );

            estadoBot.breakEvenActivado = true;

            await dbCollection.updateOne(
                { id: 'BOT_REAL' },
                { $set: estadoBot },
                { upsert: true }
            );

            await telegram.enviarMensaje(
                '🔒 *BreakEven Automático:* Riesgo eliminado. Stop Loss movido a zona segura.'
            );

        } catch (error) {
            console.error(
                'Error aplicando ajuste BreakEven:',
                error
            );
        }
    }
}

/* =========================================================
   ORQUESTADOR GENERAL Y TRATAMIENTO DE VELAS
========================================================= */
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
    } catch (e) {
        console.error(`Error de lectura en velas ${tf}:`, e);
        return [];
    }
}

async function sincronizarEstatusPosiciones() {
    const posiciones = await rpcConnection.getPositions();
    if (posiciones.length > 0) {
        const p = posiciones[0];
        estadoBot.enPosicion = true;
        estadoBot.tipo = p.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT';
        estadoBot.precioEntrada = Number(p.openPrice);
        estadoBot.ticket = p.id;
    } else {
        if (estadoBot.enPosicion) {
            await telegram.enviarMensaje('📉 *Aviso:* Operación actual cerrada en la plataforma MT5.');
        }
        estadoBot.enPosicion = false;
        estadoBot.tipo = 'NINGUNA';
        estadoBot.ticket = null;
        estadoBot.breakEvenActivado = false;
    }
    await dbCollection.updateOne({ id: 'BOT_REAL' }, { $set: estadoBot }, { upsert: true });
}

async function ejecutarCicloEstrategia() {
    if (analizando || estadoBot.faseSuperada) return;
    analizando = true;

    try {
        await sincronizarMetricasFTMO();
        await sincronizarEstatusPosiciones();
        await verificarCambioDeDia();

        if (estadoBot.perdidaDiariaActual >= FTMO_DIARIO_MAX_LOSS || estadoBot.perdidaTotalActual >= FTMO_TOTAL_MAX_LOSS) {
            analizando = false;
            return;
        }

        if (estadoBot.enPosicion) {
            await moverBreakEven();
            analizando = false;
            return;
        }

        if (estadoBot.operacionesHoy >= MAX_OPERACIONES_DIA) {
            analizando = false;
            return;
        }

        const precio = await rpcConnection.getSymbolPrice(SYMBOL);
        if (!precio || typeof precio.ask !== 'number' || typeof precio.bid !== 'number') {
    console.warn('⚠️ Precio no disponible, omitiendo ciclo.');
    analizando = false;
    return;
}
        const spec = await rpcConnection.getSymbolSpecification(SYMBOL);
        const spreadPuntos = Math.abs(precio.ask - precio.bid) / (spec.point || 0.01);
        if (spreadPuntos > MAX_SPREAD_PUNTOS) {
            analizando = false;
            return;
        }

        const velas4H = await obtenerVelasServidor(TF_MAYOR, 40);
        const velas15m = await obtenerVelasServidor(TF_ENTRADA, 30);

        if (velas4H.length === 0 || velas15m.length === 0) {
            analizando = false;
            return;
        }

        const estructura =
    SmcStrategy.analizarEstructura4H(
        velas4H
    );

const resultado =
    SmcStrategy.buscarEntrada(
        velas15m,
        estructura,
        RR
    );

console.log('═══════════════════════════════');
console.log('SESGO 4H:', estructura.sesgo);
console.log('TECHO:', estructura.techo);
console.log('PISO:', estructura.piso);
console.log('RESULTADO:', resultado);
console.log('═══════════════════════════════');

        if (resultado.accion !== 'NINGUNA') {
            const precioEntradaReal =
    resultado.accion === 'LONG'
        ? precio.ask
        : precio.bid;

const distanciaSL =
    Math.abs(
        precioEntradaReal -
        resultado.sl
    );

const lotesApropiados =
    await calcularLotesSeguros(
        distanciaSL
    );

            let ordenConfirmada;
            if (resultado.accion === 'LONG') {
                ordenConfirmada = await rpcConnection.createMarketBuyOrder(SYMBOL, lotesApropiados, resultado.sl, resultado.tp);
            } else {
                ordenConfirmada = await rpcConnection.createMarketSellOrder(SYMBOL, lotesApropiados, resultado.sl, resultado.tp);
            }

           if (ordenConfirmada) {

    estadoBot.enPosicion = true;

    estadoBot.tipo =
        resultado.accion;

    estadoBot.precioEntrada =
        precioEntradaReal;

    estadoBot.stopLoss =
        resultado.sl;

    estadoBot.takeProfit =
        resultado.tp;

    estadoBot.breakEvenActivado =
        false;
        estadoBot.ticket =
    ordenConfirmada.positionId ||
    ordenConfirmada.orderId ||
    ordenConfirmada.id;
    console.log(
    'RESPUESTA ORDEN:',
    JSON.stringify(ordenConfirmada, null, 2)
);

    estadoBot.operacionesHoy++;

    await dbCollection.updateOne(
        { id: 'BOT_REAL' },
        { $set: estadoBot },
        { upsert: true }
    );

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

    } catch (e) {
        console.error('Error detectado en el loop ejecutivo:', e);
    } finally {
        analizando = false;
    }
}

/* =========================================================
   HILO ARRANCADOR CENTRAL
========================================================= */
function registrarComandosTelegram() {
    telegram.onComando(/\/estado/, async () => {
        await sincronizarMetricasFTMO();
        await sincronizarEstatusPosiciones();
        return `
📊 *ESTADO ACTUAL DEL BOT V20*
━━━━━━━━━━━━━━━━━━━━━━━━
🤖 *Operación Flotante:* ${estadoBot.tipo}
💰 *Balance Actual:* $${estadoBot.balance.toFixed(2)}
💎 *Equity Real:* $${estadoBot.equity.toFixed(2)}
📉 *Pérdida Diaria:* -$${estadoBot.perdidaDiariaActual.toFixed(2)} / $${FTMO_DIARIO_MAX_LOSS}
📉 *Pérdida Total:* -$${estadoBot.perdidaTotalActual.toFixed(2)} / $${FTMO_TOTAL_MAX_LOSS}
⚡ *Trades Realizados Hoy:* ${estadoBot.operacionesHoy} / ${MAX_OPERACIONES_DIA}
🏆 *Prueba Superada:* ${estadoBot.faseSuperada ? 'SÍ' : 'NO'}
━━━━━━━━━━━━━━━━━━━━━━━━
        `;
    });
}

async function main() {
    console.log('🚀 Iniciando sistema...');
    
    await conectarConReintentos(() => inicializarBaseDatos(), 'MongoDB Server');
    await conectarConReintentos(() => inicializarMetaApi(), 'MetaAPI Cloud Gateway');
    
    registrarComandosTelegram();
    await telegram.enviarMensaje('🛡️ *Bot Algorítmico FTMO v20.0 Activo.* Entorno validado y monitoreando mercados.');

    while (true) {
        await ejecutarCicloEstrategia();
        await new Promise(resolve => setTimeout(resolve, 60000)); 
    }
}

main().catch(console.error);