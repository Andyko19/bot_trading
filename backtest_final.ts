// @ts-nocheck
import ccxt from 'ccxt';
import { SMA, EMA, RSI, MACD, ADX } from 'technicalindicators'; // Agregamos EMA

// ⚙️ CONFIGURACIÓN DE LA PRUEBA
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h';
const CAPITAL_INICIAL = 10000;
const RIESGO_POR_OPERACION = 1.0; 
const LIMITE_PERDIDA_DIARIA = 4.0; 

function calcularLotes(balance: number, riesgo: number, entrada: number, sl: number) {
    const distancia = Math.abs(entrada - sl);
    if (distancia === 0) return 0;
    const dineroRiesgo = balance * (riesgo / 100);
    return dineroRiesgo / distancia;
}

async function fetchHistorialCompleto(exchange: any, simbolo: string, timeframe: string, limiteVelas: number) {
    let allOHLCV: any[] = [];
    let since = undefined;
    console.log(`⏳ Descargando ~${limiteVelas} horas de datos...`);
    while (allOHLCV.length < limiteVelas) {
        const ohlcv: any = await exchange.fetchOHLCV(simbolo, timeframe, since, 1000);
        if (!ohlcv || ohlcv.length === 0) break;
        const primerTiempo = ohlcv[0][0];
        const ultimoTiempo = ohlcv[ohlcv.length - 1][0];
        if (since && primerTiempo === since) break; 
        allOHLCV = allOHLCV.concat(ohlcv);
        since = ultimoTiempo + 1; 
        process.stdout.write("."); 
        if (ohlcv.length < 1000) break; 
    }
    if (allOHLCV.length > limiteVelas) allOHLCV = allOHLCV.slice(allOHLCV.length - limiteVelas);
    console.log(`\n✅ Datos descargados: ${allOHLCV.length} velas.`);
    return allOHLCV;
}

async function correrBacktest() {
    const exchange = new ccxt.binance();
    try {
        const rawData = await fetchHistorialCompleto(exchange, SYMBOL, TIMEFRAME, 2500);
        const closes: number[] = rawData.map((v: any) => v[4]);
        const highs: number[] = rawData.map((v: any) => v[2]);
        const lows: number[] = rawData.map((v: any) => v[3]);
        const timestamps: number[] = rawData.map((v: any) => v[0]);

        console.log("🧮 Calculando indicadores (ADX, MACD, RSI, SMA 200, EMA 9)...");
        
        // Indicadores
        const sma200Values = SMA.calculate({ period: 200, values: closes });
        const ema9Values = EMA.calculate({ period: 9, values: closes }); // NUEVO: EMA 9 Rápida
        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const macdValues = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const adxValues = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });

        console.log("▶️ Iniciando Simulación V5.6 (Filtro EMA 9)...");
        console.log("---------------------------------------------------");

        let balance = CAPITAL_INICIAL;
        let operaciones = 0;
        let ganadas = 0;
        let perdidas = 0;
        let balanceInicioDia = CAPITAL_INICIAL;
        let diaActual = new Date(timestamps[200]).getDate();
        let stopTradingHoy = false;

        let enPosicion = false;
        let tipo = ''; 
        let precioEntrada = 0;
        let stopLoss = 0;
        let takeProfit = 0;
        let cantidad = 0;

        for (let i = 200; i < rawData.length - 1; i++) {
            // Gestión Fecha
            const fechaVela = new Date(timestamps[i]);
            const diaVela = fechaVela.getDate();
            if (diaVela !== diaActual) {
                diaActual = diaVela;
                balanceInicioDia = balance;
                stopTradingHoy = false;
            }
            // Kill Switch
            const perdidaHoy = balanceInicioDia - balance;
            if (perdidaHoy >= (balanceInicioDia * (LIMITE_PERDIDA_DIARIA / 100)) && !stopTradingHoy) stopTradingHoy = true;

            // Gestión Salidas
            if (enPosicion) {
                const velaSiguiente = { high: highs[i+1], low: lows[i+1] };
                let cerro = false;
                let resultado = 0;

                if (tipo === 'LONG') {
                    if (velaSiguiente.low <= stopLoss) { resultado = (stopLoss - precioEntrada) * cantidad; cerro = true; }
                    else if (velaSiguiente.high >= takeProfit) { resultado = (takeProfit - precioEntrada) * cantidad; cerro = true; }
                } else if (tipo === 'SHORT') {
                    if (velaSiguiente.high >= stopLoss) { resultado = (precioEntrada - stopLoss) * cantidad; cerro = true; }
                    else if (velaSiguiente.low <= takeProfit) { resultado = (precioEntrada - takeProfit) * cantidad; cerro = true; }
                }
                if (cerro) {
                    balance += resultado;
                    operaciones++;
                    if (resultado > 0) ganadas++; else perdidas++;
                    enPosicion = false;
                }
                continue; 
            }

            if (stopTradingHoy) continue;

            // Datos Históricos para Vela Cerrada
            const historyClose = closes.slice(0, i + 1);
            const historyHigh = highs.slice(0, i + 1);
            const historyLow = lows.slice(0, i + 1);

            const sma200Val = SMA.calculate({period: 200, values: historyClose}).pop();
            const ema9Val = EMA.calculate({period: 9, values: historyClose}).pop(); // Valor EMA 9
            const rsiVal = RSI.calculate({period: 14, values: historyClose}).pop();
            const macdVal = MACD.calculate({values: historyClose, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false});
            const adxVal = ADX.calculate({close: historyClose, high: historyHigh, low: historyLow, period: 14}).pop();

            if (!sma200Val || !ema9Val || !rsiVal || !macdVal || !adxVal || macdVal.length < 2) continue;

            const macdActual = macdVal[macdVal.length - 1];
            const macdPrevio = macdVal[macdVal.length - 2];
            const precioCierre = closes[i];

            // 1. Filtro ADX (Calidad)
            if (adxVal.adx < 25) continue;

            // 2. Cruces MACD
            const cruceAlcista = (macdPrevio.MACD < macdPrevio.signal) && (macdActual.MACD > macdActual.signal);
            const cruceBajista = (macdPrevio.MACD > macdPrevio.signal) && (macdActual.MACD < macdActual.signal);

            // 3. ESTRATEGIA CON DOBLE FILTRO (SMA 200 + EMA 9)
            
            // LONG: Precio arriba de SMA 200 Y arriba de EMA 9
            if (precioCierre > sma200Val && precioCierre > ema9Val && rsiVal < 70 && cruceAlcista) {
                const sl = Math.min(...lows.slice(i-10, i)); 
                if (sl >= precioCierre) continue;
                const tp = precioCierre + ((precioCierre - sl) * 2);
                cantidad = calcularLotes(balance, RIESGO_POR_OPERACION, precioCierre, sl);
                
                if (cantidad > 0) {
                    enPosicion = true; tipo = 'LONG'; precioEntrada = precioCierre; stopLoss = sl; takeProfit = tp;
                }
            }
            // SHORT: Precio abajo de SMA 200 Y abajo de EMA 9
            else if (precioCierre < sma200Val && precioCierre < ema9Val && rsiVal > 30 && cruceBajista) {
                const sl = Math.max(...highs.slice(i-10, i));
                if (sl <= precioCierre) continue;
                const tp = precioCierre - ((sl - precioCierre) * 2);
                cantidad = calcularLotes(balance, RIESGO_POR_OPERACION, precioCierre, sl);

                if (cantidad > 0) {
                    enPosicion = true; tipo = 'SHORT'; precioEntrada = precioCierre; stopLoss = sl; takeProfit = tp;
                }
            }
        }

        console.log("---------------------------------------------------");
        console.log(`📅 Periodo Probado: ${new Date(timestamps[0]).toLocaleDateString()} - ${new Date(timestamps[timestamps.length-1]).toLocaleDateString()}`);
        console.log("📊 RESULTADOS V5.6 (SMA200 + EMA9 + ADX):");
        console.log(`💰 Capital Final:   $${balance.toFixed(2)}`);
        const rendimiento = ((balance - CAPITAL_INICIAL)/CAPITAL_INICIAL * 100);
        console.log(`📈 Rendimiento:     ${rendimiento.toFixed(2)}%`);
        console.log(`🔢 Operaciones:     ${operaciones}`);
        console.log(`✅ Ganadas:         ${ganadas} | ❌ Perdidas: ${perdidas}`);
        const winRate = operaciones > 0 ? (ganadas/operaciones)*100 : 0;
        console.log(`🎯 Tasa de Acierto: ${winRate.toFixed(2)}%`);
        console.log("---------------------------------------------------");

    } catch (error) { console.error("Error:", error); }
}

correrBacktest();