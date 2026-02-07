import ccxt from 'ccxt';

// ⚙️ CONFIGURACIÓN DE LA PRUEBA
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h';
const CAPITAL_INICIAL = 10000;
const RIESGO_POR_OPERACION = 1.0; // 1%

// --- HERRAMIENTAS MATEMÁTICAS ---
function calculateSMA(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcularPosicion(balance: number, riesgo: number, entrada: number, sl: number) {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    return (balance * (riesgo / 100)) / distancia;
}

// --- MOTOR DE BACKTESTING ---
async function correrBacktest() {
    const exchange = new ccxt.binance();
    console.log(`⏳ Descargando datos históricos de ${SYMBOL}...`);

    try {
        // 1. Descargamos 1000 velas (aprox 1.5 meses de historia)
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 1000);
        
        // --- 🛡️ CORRECCIÓN: LIMPIEZA DE DATOS ---
        // Filtramos para asegurar que NO haya valores 'undefined'
        const velasLimpias = ohlcv.filter(v => 
            v[0] !== undefined && 
            v[1] !== undefined && 
            v[2] !== undefined && 
            v[3] !== undefined && 
            v[4] !== undefined
        );

        // Mapeamos asegurando a TypeScript que son números ("as number")
        const velas = velasLimpias.map(v => ({
            timestamp: v[0] as number,
            open: v[1] as number,
            high: v[2] as number,
            low: v[3] as number,
            close: v[4] as number
        }));

        console.log(`✅ Datos cargados y limpios: ${velas.length} velas.`);
        console.log(`🧪 INICIANDO SIMULACIÓN CON $${CAPITAL_INICIAL}...`);
        console.log("---------------------------------------------------");

        // VARIABLES DE ESTADO
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

        // 2. RECORREMOS EL TIEMPO VELA A VELA
        for (let i = 200; i < velas.length; i++) {
            
            const historiaActual = velas.slice(0, i + 1);
            const velaActual = velas[i];
            const preciosCierre = historiaActual.map(v => v.close);
            const precio = velaActual.close;

            // --- GESTIÓN DE OPERACIÓN ABIERTA ---
            if (enPosicion) {
                let resultado = 0;
                let cerro = false;

                if (tipo === 'LONG') {
                    const meta = precioEntrada + (precioEntrada - stopLoss) * 2; // Ratio 1:2
                    
                    if (velaActual.low <= stopLoss) { // Toco SL
                        resultado = (stopLoss - precioEntrada) * cantidad;
                        cerro = true;
                        console.log(`❌ ${new Date(velaActual.timestamp).toLocaleDateString()} | SL (LONG)  | Pérdida: $${resultado.toFixed(2)}`);
                    } else if (velaActual.high >= meta) { // Toco TP
                        resultado = (meta - precioEntrada) * cantidad;
                        cerro = true;
                        console.log(`✅ ${new Date(velaActual.timestamp).toLocaleDateString()} | TP (LONG)  | Ganancia: +$${resultado.toFixed(2)}`);
                    }
                } 
                else if (tipo === 'SHORT') {
                    const meta = precioEntrada - (stopLoss - precioEntrada) * 2;
                    
                    if (velaActual.high >= stopLoss) {
                        resultado = (stopLoss - precioEntrada) * cantidad; 
                        cerro = true;
                        console.log(`❌ ${new Date(velaActual.timestamp).toLocaleDateString()} | SL (SHORT) | Pérdida: $${resultado.toFixed(2)}`);
                    } else if (velaActual.low <= meta) {
                        resultado = (precioEntrada - meta) * cantidad;
                        cerro = true;
                        console.log(`✅ ${new Date(velaActual.timestamp).toLocaleDateString()} | TP (SHORT) | Ganancia: +$${resultado.toFixed(2)}`);
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

            // --- BUSQUEDA DE ENTRADA ---
            const smaFast = calculateSMA(preciosCierre, 7);
            const smaSlow = calculateSMA(preciosCierre, 25);
            const smaTrend = calculateSMA(preciosCierre, 200);

            if (smaFast && smaSlow && smaTrend) {
                const esAlcista = precio > smaTrend;
                const esBajista = precio < smaTrend;
                
                const preciosPrevios = preciosCierre.slice(0, -1);
                const smaFastPrev = calculateSMA(preciosPrevios, 7)!;
                const smaSlowPrev = calculateSMA(preciosPrevios, 25)!;

                const cruceAlcista = (smaFastPrev < smaSlowPrev) && (smaFast > smaSlow);
                const cruceBajista = (smaFastPrev > smaSlowPrev) && (smaFast < smaSlow);

                if (esAlcista && cruceAlcista) {
                    const ultimosBajos = historiaActual.slice(-5).map(v => v.low);
                    stopLoss = Math.min(...ultimosBajos);
                    cantidad = calcularPosicion(balance, RIESGO_POR_OPERACION, precio, stopLoss);
                    
                    if (cantidad > 0) {
                        enPosicion = true;
                        tipo = 'LONG';
                        precioEntrada = precio;
                    }
                } 
                else if (esBajista && cruceBajista) {
                    const ultimosAltos = historiaActual.slice(-5).map(v => v.high);
                    stopLoss = Math.max(...ultimosAltos);
                    cantidad = calcularPosicion(balance, RIESGO_POR_OPERACION, precio, stopLoss);
                    
                    if (cantidad > 0) {
                        enPosicion = true;
                        tipo = 'SHORT';
                        precioEntrada = precio;
                    }
                }
            }
        }

        // --- REPORTE FINAL ---
        console.log("---------------------------------------------------");
        console.log("📊 RESULTADOS DEL BACKTEST (Últimos ~45 días):");
        console.log(`💰 Capital Final:   $${balance.toFixed(2)}`);
        const rendimiento = ((balance - CAPITAL_INICIAL)/CAPITAL_INICIAL * 100);
        console.log(`📈 Rendimiento:     ${rendimiento.toFixed(2)}%`);
        console.log(`🔢 Total Operaciones: ${operaciones}`);
        console.log(`✅ Ganadas:         ${ganadas}`);
        console.log(`❌ Perdidas:        ${perdidas}`);
        console.log("---------------------------------------------------");

    } catch (error) {
        console.error("Error en backtest:", error);
    }
}

correrBacktest();