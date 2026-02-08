import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { SMA, RSI, MACD, ADX } from 'technicalindicators';
import fs from 'fs';

// --- CONFIGURACIÓN ---
dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error("❌ ERROR: Faltan claves de Telegram.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

// ⚙️ PARÁMETROS DE FONDEO
const SYMBOL = 'BTC/USD'; 
const TIMEFRAME = '1h'; 
const CAPITAL_INICIAL = 10000; 
const RIESGO_POR_OPERACION = 1.0; // Arriesga 1% por operación ($100 si tienes 10k)
const LIMITE_PERDIDA_DIARIA = 4.0; // Se apaga si pierde 4% en un día (Protección Fondeo)

// 💾 MEMORIA PERSISTENTE (Base de Datos)
const DB_FILE = 'estado_bot.json';

// Estructura de memoria con control de Días
let estadoBot = {
    enPosicion: false,
    tipo: 'NINGUNA', 
    precioEntrada: 0,
    stopLoss: 0,
    takeProfit: 0,
    lotes: 0,
    balance: CAPITAL_INICIAL,
    balanceInicioDia: CAPITAL_INICIAL, // Cuánto dinero tenía al empezar el día
    diaActual: new Date().toISOString().split('T')[0] // Fecha de hoy (YYYY-MM-DD)
};

// Cargar memoria al iniciar
function cargarEstado() {
    if (fs.existsSync(DB_FILE)) {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const guardado = JSON.parse(data);
        
        // Fusionamos con seguridad por si agregamos campos nuevos
        estadoBot = { ...estadoBot, ...guardado };
        console.log("💾 Memoria restaurada:", estadoBot);
    }
}

// Guardar memoria
function guardarEstado() {
    fs.writeFileSync(DB_FILE, JSON.stringify(estadoBot, null, 2));
}

cargarEstado();

// --- GESTIÓN DE RIESGO MATEMÁTICA ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    // Fórmula: (Dinero_Cuenta * %Riesgo) / Distancia_StopLoss
    const dineroArriesgar = balance * (riesgo / 100);
    return dineroArriesgar / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO V5.4 (KILL SWITCH + CONFIRMACIÓN + ADX) ---
async function analizarMercado() {
    const exchange = new ccxt.coinbase({ enableRateLimit: true });
    
    // 1. CONTROL DE CAMBIO DE DÍA 📅
    const hoy = new Date().toISOString().split('T')[0];
    if (estadoBot.diaActual !== hoy) {
        console.log(`📅 NUEVO DÍA DETECTADO: ${hoy}. Reseteando límites de pérdida.`);
        estadoBot.diaActual = hoy;
        estadoBot.balanceInicioDia = estadoBot.balance; // El balance actual es la base de hoy
        guardarEstado();
        await notificar(`📅 **NUEVO DÍA OPERATIVO**\nBalance Inicial: $${estadoBot.balance.toFixed(2)}`);
    }

    // 2. KILL SWITCH (FRENO DE MANO) 🛑
    const perdidaHoy = estadoBot.balanceInicioDia - estadoBot.balance;
    const perdidaMaximaPermitida = estadoBot.balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100);

    if (perdidaHoy >= perdidaMaximaPermitida) {
        console.log(`🛑 KILL SWITCH ACTIVADO. Pérdida hoy: -$${perdidaHoy.toFixed(2)}. Bot pausado hasta mañana.`);
        return; // ¡IMPORTANTE! Aquí cortamos la función. El bot NO analiza nada más.
    }

    console.log(`\n🛡️ V5.4 Analizando ${SYMBOL} (Riesgo: ${RIESGO_POR_OPERACION}% | Max DD: ${LIMITE_PERDIDA_DIARIA}%)`);

    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        if (!ohlcv || ohlcv.length === 0) return;

        // Limpieza de datos
        const velas = ohlcv.map(v => ({
            high: v[2] as number,
            low: v[3] as number,
            close: v[4] as number
        }));
        
        const closes = velas.map(v => v.close);
        const highs = velas.map(v => v.high);
        const lows = velas.map(v => v.low);
        const precioActual = closes[closes.length - 1]; 
        
        // --- GESTIÓN DE POSICIONES ---
        if (estadoBot.enPosicion) {
            console.log(`⏳ GESTIONANDO ${estadoBot.tipo} | Entrada: ${estadoBot.precioEntrada} | Actual: ${precioActual}`);
            
            let cerro = false;
            let resultado = 0;
            let mensaje = "";
            const velaActual = velas[velas.length - 1]; // Vela viva para chequear SL/TP

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
                
                // Aviso si estamos cerca del límite diario
                const nuevaPerdida = estadoBot.balanceInicioDia - estadoBot.balance;
                let avisoRiesgo = "";
                if (nuevaPerdida > 0) {
                    const porcentajePerdido = (nuevaPerdida / estadoBot.balanceInicioDia) * 100;
                    avisoRiesgo = `\n⚠️ Pérdida Diaria: ${porcentajePerdido.toFixed(2)}% / 4.0%`;
                }

                await notificar(`${mensaje}\n💰 Nuevo Balance: $${estadoBot.balance.toFixed(2)}${avisoRiesgo}`);
            }
            return; 
        }

        // --- INDICADORES (CON VELA CERRADA [length-2]) ---
        const closesConfirmados = closes.slice(0, -1); 
        const highsConfirmados = highs.slice(0, -1);
        const lowsConfirmados = lows.slice(0, -1);

        const sma200Arr = SMA.calculate({ period: 200, values: closesConfirmados });
        const sma200 = sma200Arr[sma200Arr.length - 1];
        const rsiArr = RSI.calculate({ period: 14, values: closesConfirmados });
        const rsi = rsiArr[rsiArr.length - 1];
        const macdArr = MACD.calculate({ values: closesConfirmados, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const macdActual = macdArr[macdArr.length - 1];
        const macdPrevio = macdArr[macdArr.length - 2];
        const adxInput = { close: closesConfirmados, high: highsConfirmados, low: lowsConfirmados, period: 14 };
        const adxResult = ADX.calculate(adxInput).pop();

        if (!sma200 || !rsi || !macdActual || !adxResult) return;

        // FILTRO LATERAL (ADX < 25)
        if (adxResult.adx < 25) {
            console.log(`💤 Mercado Lateral (ADX: ${adxResult.adx.toFixed(1)}). Esperando...`);
            return; 
        }

        const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);
        const velaCerrada = { close: closesConfirmados[closesConfirmados.length-1] };

        // --- ENTRADAS CONFIRMADAS ---

        // LONG
        if (velaCerrada.close > sma200 && rsi < 70 && cruceMacdAlcista) {
            const sl = Math.min(...lowsConfirmados.slice(-10)); 
            const tp = precioActual + ((precioActual - sl) * 2);
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'LONG', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual
            };
            guardarEstado();

            const msg = `🚀 COMPRA (LONG)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nRiesgo: 1% ($${(estadoBot.balance * 0.01).toFixed(0)})\n\n✅ Señal Confirmada.`;
            await notificar(msg);
        }

        // SHORT
        else if (velaCerrada.close < sma200 && rsi > 30 && cruceMacdBajista) {
            const sl = Math.max(...highsConfirmados.slice(-10)); 
            const tp = precioActual - ((sl - precioActual) * 2);
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'SHORT', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual
            };
            guardarEstado();

            const msg = `📉 VENTA (SHORT)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nRiesgo: 1% ($${(estadoBot.balance * 0.01).toFixed(0)})\n\n✅ Señal Confirmada.`;
            await notificar(msg);
        } else {
            console.log(`👀 Vigilando... RSI: ${rsi.toFixed(1)} | ADX: ${adxResult.adx.toFixed(1)}`);
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

async function startBot() {
    await notificar(`🛡️ BOT V5.4 (FINAL) ACTIVO\n\n💰 Cuenta: $${CAPITAL_INICIAL}\n⚠️ Riesgo Op: ${RIESGO_POR_OPERACION}%\n🛑 Límite Diario: ${LIMITE_PERDIDA_DIARIA}%`);
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();