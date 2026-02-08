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

const bot = new TelegramBot(token, { polling: false });

// ⚙️ PARÁMETROS GANADORES (Validado en Backtest)
const SYMBOL = 'BTC/USD';   // El Rey Bitcoin (Estrategia Survivor)
const TIMEFRAME = '1h';     // Gráfico de 1 Hora
const CAPITAL_INICIAL = 10000; 
const RIESGO_POR_OPERACION = 1.0; // 1% ($100 por trade si tienes 10k)
const LIMITE_PERDIDA_DIARIA = 4.0; // 4% (Protección Anti-Quiebra Fondeo)

// 💾 MEMORIA PERSISTENTE (Anti-Reinicios Railway)
const DB_FILE = 'estado_bot.json';

let estadoBot = {
    enPosicion: false,
    tipo: 'NINGUNA', 
    precioEntrada: 0,
    stopLoss: 0,
    takeProfit: 0,
    lotes: 0,
    balance: CAPITAL_INICIAL,
    balanceInicioDia: CAPITAL_INICIAL,
    diaActual: new Date().toISOString().split('T')[0]
};

// Cargar memoria al despertar (Si Railway se reinicia)
function cargarEstado() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const guardado = JSON.parse(data);
            estadoBot = { ...estadoBot, ...guardado };
            console.log("💾 Memoria restaurada correctamente:", estadoBot);
        } catch (error) {
            console.error("⚠️ Error leyendo memoria, iniciando desde cero.");
        }
    }
}

// Guardar memoria cada vez que hacemos algo importante
function guardarEstado() {
    fs.writeFileSync(DB_FILE, JSON.stringify(estadoBot, null, 2));
}

cargarEstado();

// --- CALCULADORA DE LOTAJE (Gestión de Riesgo) ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    // Fórmula: Dinero_a_Perder / Distancia_SL
    const dineroArriesgar = balance * (riesgo / 100);
    return dineroArriesgar / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO MAESTRO V5.5 (FINAL) ---
async function analizarMercado() {
    // Usamos COINBASE para evitar bloqueo en EE.UU. (Railway)
    const exchange = new ccxt.coinbase({ enableRateLimit: true });
    
    // 1. GESTIÓN DEL DÍA (Reset diario para el Kill Switch)
    const hoy = new Date().toISOString().split('T')[0];
    if (estadoBot.diaActual !== hoy) {
        estadoBot.diaActual = hoy;
        estadoBot.balanceInicioDia = estadoBot.balance;
        guardarEstado();
        await notificar(`📅 **NUEVO DÍA OPERATIVO**\nBalance Inicio: $${estadoBot.balance.toFixed(2)}\nKill Switch: Reseteado.`);
    }

    // 2. KILL SWITCH (Protección de Cuenta)
    const perdidaHoy = estadoBot.balanceInicioDia - estadoBot.balance;
    const limiteDinero = estadoBot.balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100);

    // Si hemos perdido más del 4% hoy, APAGAMOS EL CEREBRO hasta mañana
    if (perdidaHoy >= limiteDinero) {
        console.log(`🛑 KILL SWITCH ACTIVADO. Pérdida: -$${perdidaHoy.toFixed(2)}`);
        return; 
    }

    console.log(`\n🛡️ V5.5 Analizando ${SYMBOL}...`);

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
        
        // --- GESTIÓN DE SALIDAS (SL/TP en tiempo real) ---
        if (estadoBot.enPosicion) {
            console.log(`⏳ GESTIONANDO ${estadoBot.tipo} | Entrada: ${estadoBot.precioEntrada} | Actual: ${precioActual}`);
            
            let cerro = false;
            let resultado = 0;
            let mensaje = "";
            const velaActual = velas[velas.length - 1]; // Usamos la vela actual para cerrar rápido

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
                await notificar(`${mensaje}\n💰 Nuevo Balance Simulado: $${estadoBot.balance.toFixed(2)}`);
            }
            return; // Si estamos dentro, no buscamos nuevas entradas
        }

        // --- CÁLCULO DE INDICADORES (Sobre Vela CERRADA) ---
        // Eliminamos la última vela para no caer en trampas de repintado
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

        // FILTRO DE CALIDAD (ADX < 25 se ignora)
        if (adxResult.adx < 25) {
            console.log(`💤 Mercado Lateral (ADX: ${adxResult.adx.toFixed(1)}). Esperando tendencia...`);
            return; 
        }

        const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);
        
        // Precio de cierre de la vela CONFIRMADA
        const precioCierreVelaAnterior = closesConfirmados[closesConfirmados.length-1];

        // --- ENTRADAS MAESTRAS ---

        // LONG (Compra)
        if (precioCierreVelaAnterior > sma200 && rsi < 70 && cruceMacdAlcista) {
            const sl = Math.min(...lowsConfirmados.slice(-10)); // SL en el último bajo
            const tp = precioActual + ((precioActual - sl) * 2); // Ratio 1:2
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'LONG', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual
            };
            guardarEstado();

            const msg = `🚀 COMPRA (LONG)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nRiesgo: 1% ($${(estadoBot.balance * 0.01).toFixed(0)})\nADX: ${adxResult.adx.toFixed(1)}\n\n✅ Señal Confirmada V5.5`;
            console.log("🔥 SEÑAL DE COMPRA ENVIADA");
            await notificar(msg);
        }

        // SHORT (Venta)
        else if (precioCierreVelaAnterior < sma200 && rsi > 30 && cruceMacdBajista) {
            const sl = Math.max(...highsConfirmados.slice(-10)); // SL en el último alto
            const tp = precioActual - ((sl - precioActual) * 2); // Ratio 1:2
            const lotes = calcularTamanoPosicion(estadoBot.balance, RIESGO_POR_OPERACION, precioActual, sl);

            estadoBot = { 
                enPosicion: true, tipo: 'SHORT', precioEntrada: precioActual, 
                stopLoss: sl, takeProfit: tp, lotes: lotes, balance: estadoBot.balance,
                balanceInicioDia: estadoBot.balanceInicioDia, diaActual: estadoBot.diaActual
            };
            guardarEstado();

            const msg = `📉 VENTA (SHORT)\nPrecio: $${precioActual}\nSL: $${sl}\nTP: $${tp}\nRiesgo: 1% ($${(estadoBot.balance * 0.01).toFixed(0)})\nADX: ${adxResult.adx.toFixed(1)}\n\n✅ Señal Confirmada V5.5`;
            console.log("🔥 SEÑAL DE VENTA ENVIADA");
            await notificar(msg);
        } else {
            console.log(`👀 Vigilando... RSI: ${rsi.toFixed(1)} | ADX: ${adxResult.adx.toFixed(1)}`);
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

async function startBot() {
    await notificar(`🛡️ BOT V5.5 FINAL ACTIVO\nModo: Simulación Fondeo\nCuenta: $${CAPITAL_INICIAL}\nEstrategia: BTC Only`);
    setInterval(analizarMercado, 60 * 1000); 
}

startBot();