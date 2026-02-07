import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
// Importamos la librería profesional de indicadores
import { SMA, RSI, MACD } from 'technicalindicators';

// --- CONFIGURACIÓN ---
const resultado = dotenv.config();
if (resultado.error) process.exit(1);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN!, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID;

// ⚙️ PARÁMETROS CUENTA DE FONDEO ($10k)
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h'; 
const CAPITAL_CUENTA = 10000; 
const RIESGO_POR_OPERACION = 1.0; // 1% ($100) máximo de pérdida por trade

// --- GESTIÓN DE RIESGO MATEMÁTICA ---
function calcularTamanoPosicion(balance: number, riesgo: number, entrada: number, sl: number): number {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    // Fórmula: (Capital * %Riesgo) / Distancia al StopLoss
    return (balance * (riesgo / 100)) / distancia;
}

async function notificar(msg: string) {
    try { await bot.sendMessage(chatId!, msg); } catch (e) { console.error(e); }
}

// --- CEREBRO DEL BOT (ESTRATEGIA MACD + RSI + SMA200) ---
async function analizarMercado() {
    // Usamos Binance
    const exchange = new ccxt.binance({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_SECRET,
        enableRateLimit: true
    });
    
    // MODO TESTNET (Cámbialo a false cuando vayas a real)
    exchange.setSandboxMode(true); 

    console.log(`\n🔍 Analizando ${SYMBOL} con Estrategia PROP FIRM (MACD+RSI)...`);

    try {
        // 1. Descargamos 300 velas
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 300);
        
        // Limpieza de datos
        const velas = ohlcv.filter(v => v[4] !== undefined);
        const closes = velas.map(v => v[4] as number);
        const highs = velas.map(v => v[2] as number);
        const lows = velas.map(v => v[3] as number);
        const currentPrice = closes[closes.length - 1];

        // 2. CALCULAMOS INDICADORES
        // A. SMA 200 (Tendencia Mayor)
        const sma200Values = SMA.calculate({ period: 200, values: closes });
        const sma200 = sma200Values[sma200Values.length - 1];

        // B. RSI 14 (Sobrecompra/Sobreventa)
        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const rsi = rsiValues[rsiValues.length - 1];

        // C. MACD (12, 26, 9) - El Gatillo
        const macdValues = MACD.calculate({
            values: closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });
        const macdActual = macdValues[macdValues.length - 1];
        const macdPrevio = macdValues[macdValues.length - 2];

        // 3. VALIDAMOS SI HAY DATOS SUFICIENTES
        if (!sma200 || !rsi || !macdActual) {
            console.log("⚠️ Calculando indicadores (Faltan datos históricos)...");
            return;
        }

        console.log(`📊 DATOS TÉCNICOS:`);
        console.log(`   Precio: $${currentPrice}`);
        console.log(`   SMA 200: $${sma200.toFixed(2)} (${currentPrice > sma200 ? 'ALCISTA' : 'BAJISTA'})`);
        console.log(`   RSI: ${rsi.toFixed(2)}`);
        console.log(`   MACD: ${macdActual.MACD?.toFixed(2)} | Signal: ${macdActual.signal?.toFixed(2)}`);

        // -----------------------------------------------------------
        // 🚦 REGLAS DE LA ESTRATEGIA "PROP FIRM HUNTER"
        // -----------------------------------------------------------
        
        // Detectar Cruce de MACD
        // Cruce Alcista: La línea MACD cruza hacia ARRIBA de la Señal
        const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
        // Cruce Bajista: La línea MACD cruza hacia ABAJO de la Señal
        const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);

        // --- ESCENARIO DE COMPRA (LONG) ---
        // 1. Tendencia: Precio ENCIMA de la SMA 200
        // 2. RSI: NO debe estar sobrecomprado (Menor a 70). Idealmente viene de abajo.
        // 3. MACD: Cruce Alcista confirmado
        if (currentPrice > sma200 && rsi < 70 && cruceMacdAlcista) {
            
            // Stop Loss: El mínimo de las últimas 10 velas (Swing Low)
            const stopLoss = Math.min(...lows.slice(-10));
            // Take Profit: Ratio 1:2 (Ganar el doble de lo que arriesgas)
            const riesgo = currentPrice - stopLoss;
            const takeProfit = currentPrice + (riesgo * 2);

            // Gestión de Riesgo
            const lotes = calcularTamanoPosicion(CAPITAL_CUENTA, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            // EJECUCIÓN (TESTNET)
            // En real usaríamos: await exchange.createOrder(...)
            
            const mensaje = `🚀 SEÑAL DE COMPRA (LONG)\n\nPrecio: $${currentPrice}\nStop Loss: $${stopLoss}\nTake Profit: $${takeProfit}\n\n🛡️ GESTIÓN DE RIESGO ($10k):\nArriesgamos: $${(riesgo*lotes).toFixed(2)} (1%)\nLotes a Operar: ${lotes.toFixed(4)} BTC\n\n✅ Confirmado por MACD + RSI.`;
            
            console.log("🔥 OPORTUNIDAD LONG DETECTADA");
            await notificar(mensaje);
        }

        // --- ESCENARIO DE VENTA (SHORT) ---
        // 1. Tendencia: Precio DEBAJO de la SMA 200
        // 2. RSI: NO debe estar sobrevendido (Mayor a 30).
        // 3. MACD: Cruce Bajista confirmado
        else if (currentPrice < sma200 && rsi > 30 && cruceMacdBajista) {
            
            // Stop Loss: El máximo de las últimas 10 velas (Swing High)
            const stopLoss = Math.max(...highs.slice(-10));
            const riesgo = stopLoss - currentPrice;
            const takeProfit = currentPrice - (riesgo * 2);

            const lotes = calcularTamanoPosicion(CAPITAL_CUENTA, RIESGO_POR_OPERACION, currentPrice, stopLoss);

            const mensaje = `📉 SEÑAL DE VENTA (SHORT)\n\nPrecio: $${currentPrice}\nStop Loss: $${stopLoss}\nTake Profit: $${takeProfit}\n\n🛡️ GESTIÓN DE RIESGO ($10k):\nArriesgamos: $${(riesgo*lotes).toFixed(2)} (1%)\nLotes a Operar: ${lotes.toFixed(4)} BTC\n\n✅ Confirmado por MACD + RSI.`;

            console.log("🔥 OPORTUNIDAD SHORT DETECTADA");
            await notificar(mensaje);
        } else {
            console.log("💤 Sin entradas válidas. Esperando configuración perfecta...");
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

// Bucle
async function startBot() {
    await notificar("🤖 BOT V4.0 ACTIVO: Estrategia MACD + RSI cargada.");
    setInterval(analizarMercado, 60 * 1000); // Revisar cada minuto
}

startBot();