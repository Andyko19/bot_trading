import ccxt from 'ccxt';
// Importamos la librería técnica para calcular igual que el bot en vivo
import { SMA, RSI, MACD } from 'technicalindicators';

// ⚙️ CONFIGURACIÓN DE LA PRUEBA
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h';
const CAPITAL_INICIAL = 10000;
const RIESGO_POR_OPERACION = 1.0; // 1%

// --- HERRAMIENTAS MATEMÁTICAS ---
function calcularPosicion(balance: number, riesgo: number, entrada: number, sl: number) {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    return (balance * (riesgo / 100)) / distancia;
}

// --- MOTOR DE BACKTESTING ---
async function correrBacktest() {
    const exchange = new ccxt.binance();
    console.log(`⏳ Descargando datos históricos de ${SYMBOL} para probar ESTRATEGIA V4 (MACD+RSI)...`);

    try {
        // Descargamos 1000 velas (aprox 45 días)
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 1000);
        
        // Limpieza de datos
        const velasLimpias = ohlcv.filter(v => v[4] !== undefined);
        
        // Preparamos arrays básicos
        const closes = velasLimpias.map(v => v[4] as number);
        const highs = velasLimpias.map(v => v[2] as number);
        const lows = velasLimpias.map(v => v[3] as number);
        const timestamps = velasLimpias.map(v => v[0] as number);

        // --- CÁLCULO PREVIO DE INDICADORES (OPTIMIZACIÓN) ---
        // Calculamos todo de golpe para que sea rápido
        console.log("🧮 Calculando indicadores técnicos...");
        
        const sma200Values = SMA.calculate({ period: 200, values: closes });
        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const macdValues = MACD.calculate({
            values: closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });

        // NOTA TÉCNICA:
        // Las librerías devuelven arrays de diferente tamaño.
        // RSI empieza en la vela 14. SMA200 empieza en la vela 200.
        // Tenemos que alinear los índices.
        // Para simplificar este script, haremos el cálculo "en vivo" dentro del bucle 
        // simulando lo que hace el bot real.

        console.log(`🧪 INICIANDO SIMULACIÓN CON $${CAPITAL_INICIAL}...`);
        console.log("---------------------------------------------------");

        let balance = CAPITAL_INICIAL;
        let operaciones = 0;
        let ganadas = 0;
        let perdidas = 0;
        
        // Memoria de la operación
        let enPosicion = false;
        let tipo = ''; 
        let precioEntrada = 0;
        let stopLoss = 0;
        let cantidad = 0;

        // Empezamos en la vela 201 para tener datos suficientes para la SMA 200
        for (let i = 201; i < velasLimpias.length; i++) {
            
            const velaActual = {
                ts: timestamps[i],
                open: velasLimpias[i][1],
                high: highs[i],
                low: lows[i],
                close: closes[i]
            };

            // --- GESTIÓN DE OPERACIÓN ABIERTA ---
            if (enPosicion) {
                let resultado = 0;
                let cerro = false;

                if (tipo === 'LONG') {
                    const meta = precioEntrada + (precioEntrada - stopLoss) * 2; // Ratio 1:2
                    
                    if (velaActual.low <= stopLoss) { // Stop Loss
                        resultado = (stopLoss - precioEntrada) * cantidad;
                        cerro = true;
                        // console.log(`❌ SL (LONG) | Pérdida: $${resultado.toFixed(2)}`);
                    } else if (velaActual.high >= meta) { // Take Profit
                        resultado = (meta - precioEntrada) * cantidad;
                        cerro = true;
                        // console.log(`✅ TP (LONG) | Ganancia: +$${resultado.toFixed(2)}`);
                    }
                } 
                else if (tipo === 'SHORT') {
                    const meta = precioEntrada - (stopLoss - precioEntrada) * 2;
                    
                    if (velaActual.high >= stopLoss) { // Stop Loss
                        resultado = (stopLoss - precioEntrada) * cantidad; 
                        cerro = true;
                        // console.log(`❌ SL (SHORT)| Pérdida: $${resultado.toFixed(2)}`);
                    } else if (velaActual.low <= meta) { // Take Profit
                        resultado = (precioEntrada - meta) * cantidad;
                        cerro = true;
                        // console.log(`✅ TP (SHORT)| Ganancia: +$${resultado.toFixed(2)}`);
                    }
                }

                if (cerro) {
                    balance += resultado;
                    operaciones++;
                    if (resultado > 0) ganadas++; else perdidas++;
                    enPosicion = false; 
                }
                continue; 
            }

            // --- BUSQUEDA DE ENTRADA (MIMETIZANDO AL BOT REAL) ---
            
            // Recortamos la historia hasta el punto 'i'
            // NOTA: Esto es ineficiente en backtest masivo, pero seguro para verificar lógica
            const historiaClose = closes.slice(0, i + 1);

            // 1. Indicadores Actuales
            const sma200Arr = SMA.calculate({period: 200, values: historiaClose});
            const rsiArr = RSI.calculate({period: 14, values: historiaClose});
            const macdArr = MACD.calculate({values: historiaClose, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false});

            const sma200 = sma200Arr[sma200Arr.length - 1];
            const rsi = rsiArr[rsiArr.length - 1];
            const macdActual = macdArr[macdArr.length - 1];
            const macdPrevio = macdArr[macdArr.length - 2];

            if (!sma200 || !rsi || !macdActual || !macdPrevio) continue;

            // 2. Lógica de Cruces
            const cruceMacdAlcista = (macdPrevio.MACD! < macdPrevio.signal!) && (macdActual.MACD! > macdActual.signal!);
            const cruceMacdBajista = (macdPrevio.MACD! > macdPrevio.signal!) && (macdActual.MACD! < macdActual.signal!);

            // 3. Reglas de Entrada
            if (velaActual.close > sma200 && rsi < 70 && cruceMacdAlcista) {
                // LONG
                const ultimos10Bajos = lows.slice(i-10, i);
                stopLoss = Math.min(...ultimos10Bajos);
                cantidad = calcularPosicion(balance, RIESGO_POR_OPERACION, velaActual.close, stopLoss);
                
                if (cantidad > 0) {
                    enPosicion = true;
                    tipo = 'LONG';
                    precioEntrada = velaActual.close;
                    console.log(`🚀 ${new Date(velaActual.ts).toLocaleDateString()} | ENTRADA LONG @ $${velaActual.close}`);
                }
            }
            else if (velaActual.close < sma200 && rsi > 30 && cruceMacdBajista) {
                // SHORT
                const ultimos10Altos = highs.slice(i-10, i);
                stopLoss = Math.max(...ultimos10Altos);
                cantidad = calcularPosicion(balance, RIESGO_POR_OPERACION, velaActual.close, stopLoss);

                if (cantidad > 0) {
                    enPosicion = true;
                    tipo = 'SHORT';
                    precioEntrada = velaActual.close;
                    console.log(`📉 ${new Date(velaActual.ts).toLocaleDateString()} | ENTRADA SHORT @ $${velaActual.close}`);
                }
            }
        }

        // --- REPORTE FINAL COMPARATIVO ---
        console.log("---------------------------------------------------");
        console.log("📊 RESULTADOS V4 (MACD + RSI + SMA200):");
        console.log(`💰 Capital Final:   $${balance.toFixed(2)}`);
        const rendimiento = ((balance - CAPITAL_INICIAL)/CAPITAL_INICIAL * 100);
        console.log(`📈 Rendimiento:     ${rendimiento.toFixed(2)}%`);
        console.log(`🔢 Total Operaciones: ${operaciones}`);
        console.log(`✅ Ganadas:         ${ganadas}`);
        console.log(`❌ Perdidas:        ${perdidas}`);
        
        const winRate = operaciones > 0 ? (ganadas/operaciones)*100 : 0;
        console.log(`🎯 Tasa de Acierto: ${winRate.toFixed(2)}%`);
        console.log("---------------------------------------------------");

    } catch (error) {
        console.error("Error en backtest:", error);
    }
}

correrBacktest();