export interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface ResultadoEstrategia {
    accion: 'LONG' | 'SHORT' | 'NINGUNA';
    precioEntrada: number;
    sl: number;
    tp: number;
    motivo: string;
}

export class SmcStrategy {

    private static esSwingHigh(velas: Candle[], idx: number): boolean {
        if (idx < 2 || idx > velas.length - 3) return false;
        const v = velas[idx].high;
        return v > velas[idx-1].high && v > velas[idx-2].high && v > velas[idx+1].high && v > velas[idx+2].high;
    }

    private static esSwingLow(velas: Candle[], idx: number): boolean {
        if (idx < 2 || idx > velas.length - 3) return false;
        const v = velas[idx].low;
        return v < velas[idx-1].low && v < velas[idx-2].low && v < velas[idx+1].low && v < velas[idx+2].low;
    }

    public static analizarEstructura4H(velas: Candle[]): { sesgo: 'ALCISTA' | 'BAJISTA' | 'RANGO'; techo: number; piso: number } {
        let techo = 0;
        let piso = Infinity;

        for (let i = velas.length - 3; i >= 2; i--) {
            if (this.esSwingHigh(velas, i) && techo === 0) techo = velas[i].high;
            if (this.esSwingLow(velas, i) && piso === Infinity) piso = velas[i].low;
            if (techo !== 0 && piso !== Infinity) break;
        }
    

        const ultimaVela = velas[velas.length - 1];
        

        if (techo !== 0 && ultimaVela.close > techo) {
            return { sesgo: 'ALCISTA', techo, piso };
        }
        if (piso !== Infinity && ultimaVela.close < piso) {
            return { sesgo: 'BAJISTA', techo, piso };
        }
const ultimas5Velas = velas.slice(-5);

let cierresAlcistas = 0;
let cierresBajistas = 0;

for (let i = 1; i < ultimas5Velas.length; i++) {

    if (
        ultimas5Velas[i].close >
        ultimas5Velas[i - 1].close
    ) {
        cierresAlcistas++;
    }

    if (
        ultimas5Velas[i].close <
        ultimas5Velas[i - 1].close
    ) {
        cierresBajistas++;
    }
}

if (cierresAlcistas >= 3) {
    return {
        sesgo: 'ALCISTA',
        techo,
        piso
    };
}

if (cierresBajistas >= 3) {
    return {
        sesgo: 'BAJISTA',
        techo,
        piso
    };
}
const rango4H =
    Math.abs(techo - piso);

if (rango4H < 300) {
    return {
        sesgo: 'RANGO',
        techo,
        piso
    };
}
        return { sesgo: 'RANGO', techo, piso };
    }

    public static buscarEntrada(
        velas15m: Candle[], 
        estructura4H: { sesgo: 'ALCISTA' | 'BAJISTA' | 'RANGO'; techo: number; piso: number }, 
        rr: number
    ): ResultadoEstrategia {
        const len = velas15m.length;
        if (len < 8) return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Falta histórico de velas' };

        const precioActual = velas15m[len - 1].close;
        let puntoA = estructura4H.piso;
        let puntoB = estructura4H.techo;
        if (
    puntoA === Infinity ||
    puntoB === 0
) {
    return {
        accion: 'NINGUNA',
        precioEntrada: 0,
        sl: 0,
        tp: 0,
        motivo: 'Swings 4H insuficientes'
    };
}

        if (estructura4H.sesgo === 'ALCISTA') {

    const distanciaTotal = puntoB - puntoA;

    if (distanciaTotal <= 0) {
        return {
            accion: 'NINGUNA',
            precioEntrada: 0,
            sl: 0,
            tp: 0,
            motivo: 'Estructura inválida'
        };
    }

    const fibo618 = puntoB - (distanciaTotal * 0.618);
    const fibo786 = puntoB - (distanciaTotal * 0.786);

    if (precioActual <= fibo618 && precioActual >= fibo786) {

        const v1 = velas15m[len - 4];
        const v2 = velas15m[len - 3];
        const v3 = velas15m[len - 2];

        const tamañoFVG = v3.low - v1.high;
        const porcentajeFVG =
    tamañoFVG / precioActual;

        const maximoReciente = Math.max(
    ...velas15m
        .slice(len - 10, len - 1)
        .map(v => v.high)
);

        if (
            
    porcentajeFVG > 0.0005 &&
            v2.close > v2.open &&
            velas15m[len - 1].close > maximoReciente
        ) {

           const sl =
    Math.min(v1.low, fibo786) - 50;

            const riesgo = precioActual - sl;

            if (riesgo <= 0) {
                return {
                    accion: 'NINGUNA',
                    precioEntrada: 0,
                    sl: 0,
                    tp: 0,
                    motivo: 'Riesgo inválido'
                };
            }

            return {
                accion: 'LONG',
                precioEntrada: precioActual,
                sl,
                tp: precioActual + (riesgo * rr),
                motivo: 'OTE + FVG válido + BOS Alcista'
            };
        }
    }

    return {
        accion: 'NINGUNA',
        precioEntrada: 0,
        sl: 0,
        tp: 0,
        motivo: 'Fuera de zona OTE Alcista'
    };
}

        if (estructura4H.sesgo === 'BAJISTA') {

    const distanciaTotal = puntoB - puntoA;

    if (distanciaTotal <= 0) {
        return {
            accion: 'NINGUNA',
            precioEntrada: 0,
            sl: 0,
            tp: 0,
            motivo: 'Estructura inválida'
        };
    }

    const fibo618 = puntoA + (distanciaTotal * 0.618);
    const fibo786 = puntoA + (distanciaTotal * 0.786);

    if (precioActual >= fibo618 && precioActual <= fibo786) {

        const v1 = velas15m[len - 4];
        const v2 = velas15m[len - 3];
        const v3 = velas15m[len - 2];

        const tamañoFVG = v1.low - v3.high;

        const minimoReciente = Math.min(
    ...velas15m
        .slice(len - 10, len - 1)
        .map(v => v.low)
);

        if (
            tamañoFVG > 20 &&
            v2.close < v2.open &&
            velas15m[len - 1].close < minimoReciente
        ) {

            const sl =
    Math.max(v1.high, fibo786) + 50;

            const riesgo = sl - precioActual;

            if (riesgo <= 0) {
                return {
                    accion: 'NINGUNA',
                    precioEntrada: 0,
                    sl: 0,
                    tp: 0,
                    motivo: 'Riesgo inválido'
                };
            }

            return {
                accion: 'SHORT',
                precioEntrada: precioActual,
                sl,
                tp: precioActual - (riesgo * rr),
                motivo: 'OTE + FVG válido + BOS Bajista'
            };
        }
    }

    return {
        accion: 'NINGUNA',
        precioEntrada: 0,
        sl: 0,
        tp: 0,
        motivo: 'Fuera de zona OTE Bajista'
    };
}
        if (estructura4H.sesgo === 'RANGO') {
            const zonaSoporteSms = estructura4H.piso * 1.002;
            const zonaResistenciaSms = estructura4H.techo * 0.998;

            if (precioActual <= zonaSoporteSms) {
    const v1 = velas15m[len - 4];
    const v2 = velas15m[len - 3];
    const v3 = velas15m[len - 2];

    if (
        v3.low > v1.high &&
        v2.close > v2.open
    ) {
                    const sl = estructura4H.piso * 0.995;
                    return {
                        accion: 'LONG',
                        precioEntrada: precioActual,
                        sl,
                        tp: estructura4H.techo,
                        motivo: 'Compra institucional en soporte de rango lateral 4H'
                    };
                }
            }

            if (precioActual >= zonaResistenciaSms) {

    const v1 = velas15m[len - 4];
    const v2 = velas15m[len - 3];
    const v3 = velas15m[len - 2];

    if (
        v3.high < v1.low &&
        v2.close < v2.open
    ) {
                    const sl = estructura4H.techo * 1.005;
                    return {
                        accion: 'SHORT',
                        precioEntrada: precioActual,
                        sl,
                        tp: estructura4H.piso,
                        motivo: 'Venta institucional en resistencia de rango lateral 4H'
                    };
                }
            }
        }

        return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Mercado consolidando sin gatillo claro' };
    }
}