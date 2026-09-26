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
        return v > velas[idx - 1].high && v > velas[idx - 2].high && v > velas[idx + 1].high && v > velas[idx + 2].high;
    }

    private static esSwingLow(velas: Candle[], idx: number): boolean {
        if (idx < 2 || idx > velas.length - 3) return false;
        const v = velas[idx].low;
        return v < velas[idx - 1].low && v < velas[idx - 2].low && v < velas[idx + 1].low && v < velas[idx + 2].low;
    }

    public static analizarEstructura4H(velas: Candle[]): { sesgo: 'ALCISTA' | 'BAJISTA' | 'RANGO'; techo: number; piso: number } {
        let techo = 0;
        let piso = Infinity;

        for (let i = velas.length - 3; i >= 2; i--) {
            if (this.esSwingHigh(velas, i) && techo === 0) techo = velas[i].high;
            if (this.esSwingLow(velas, i) && piso === Infinity) piso = velas[i].low;
            if (techo !== 0 && piso !== Infinity) break;
        }

        if (techo === 0 || piso === Infinity || techo <= piso) {
            return { sesgo: 'RANGO', techo, piso };
        }

        const ultimaVela = velas[velas.length - 1];

        if (ultimaVela.close > techo) {
            return { sesgo: 'ALCISTA', techo, piso };
        }
        if (ultimaVela.close < piso) {
            return { sesgo: 'BAJISTA', techo, piso };
        }

        const ultimas5Velas = velas.slice(-5);
        let cierresAlcistas = 0;
        let cierresBajistas = 0;

        for (let i = 1; i < ultimas5Velas.length; i++) {
            if (ultimas5Velas[i].close > ultimas5Velas[i - 1].close) cierresAlcistas++;
            if (ultimas5Velas[i].close < ultimas5Velas[i - 1].close) cierresBajistas++;
        }

        if (cierresAlcistas >= 4) return { sesgo: 'ALCISTA', techo, piso };
        if (cierresBajistas >= 4) return { sesgo: 'BAJISTA', techo, piso };

        return { sesgo: 'RANGO', techo, piso };
    }

    public static buscarEntrada(
        velas15m: Candle[], 
        estructura4H: { sesgo: 'ALCISTA' | 'BAJISTA' | 'RANGO'; techo: number; piso: number }, 
        rr: number
    ): ResultadoEstrategia {
        const len = velas15m.length;
        if (len < 10) {
            return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Velas 15m insuficientes' };
        }

        const precioActual = velas15m[len - 1].close;
        const puntoA = estructura4H.piso;
        const puntoB = estructura4H.techo;

        if (puntoA === Infinity || puntoB === 0 || puntoB <= puntoA) {
            return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Swings 4H no delimitados' };
        }

        const distanciaTotal = puntoB - puntoA;
        const v1 = velas15m[len - 4];
        const v2 = velas15m[len - 3];
        const v3 = velas15m[len - 2];
        const vActual = velas15m[len - 1];

        if (estructura4H.sesgo === 'ALCISTA') {
            const fibo618 = puntoB - (distanciaTotal * 0.618);
            const fibo786 = puntoB - (distanciaTotal * 0.786);

            const enZonaOTE = precioActual <= fibo618 && precioActual >= fibo786;
            const gapAlcista = v3.low - v1.high;
            const tieneFVG = (gapAlcista / precioActual) > 0.0003;
            const rechazoVela = vActual.close > vActual.open && vActual.close > v3.high;

            if (enZonaOTE && (tieneFVG || rechazoVela)) {
                const sl = Math.min(v1.low, fibo786) - (precioActual * 0.001);
                const riesgo = precioActual - sl;

                if (riesgo > 0) {
                    return {
                        accion: 'LONG',
                        precioEntrada: precioActual,
                        sl: Number(sl.toFixed(2)),
                        tp: Number((precioActual + (riesgo * rr)).toFixed(2)),
                        motivo: 'OTE Alcista (61.8-78.6) + Confirmación de Gatillo'
                    };
                }
            }
            return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Condición Alcista no completada' };
        }

        if (estructura4H.sesgo === 'BAJISTA') {
            const fibo618 = puntoA + (distanciaTotal * 0.618);
            const fibo786 = puntoA + (distanciaTotal * 0.786);

            const enZonaOTE = precioActual >= fibo618 && precioActual <= fibo786;
            const gapBajista = v1.low - v3.high;
            const tieneFVG = (gapBajista / precioActual) > 0.0003;
            const rechazoVela = vActual.close < vActual.open && vActual.close < v3.low;

            if (enZonaOTE && (tieneFVG || rechazoVela)) {
                const sl = Math.max(v1.high, fibo786) + (precioActual * 0.001);
                const riesgo = sl - precioActual;

                if (riesgo > 0) {
                    return {
                        accion: 'SHORT',
                        precioEntrada: precioActual,
                        sl: Number(sl.toFixed(2)),
                        tp: Number((precioActual - (riesgo * rr)).toFixed(2)),
                        motivo: 'OTE Bajista (61.8-78.6) + Confirmación de Gatillo'
                    };
                }
            }
            return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Condición Bajista no completada' };
        }

        if (estructura4H.sesgo === 'RANGO') {
            const zonaSoporte = puntoA * 1.003;
            const zonaResistencia = puntoB * 0.997;

            if (precioActual <= zonaSoporte && vActual.close > vActual.open) {
                const sl = puntoA * 0.997;
                const riesgo = precioActual - sl;
                const beneficio = puntoB - precioActual;

                if (riesgo > 0 && (beneficio / riesgo) >= rr) {
                    return {
                        accion: 'LONG',
                        precioEntrada: precioActual,
                        sl: Number(sl.toFixed(2)),
                        tp: Number(puntoB.toFixed(2)),
                        motivo: 'Rebote en soporte de rango 4H con R:R válido'
                    };
                }
            }

            if (precioActual >= zonaResistencia && vActual.close < vActual.open) {
                const sl = puntoB * 1.003;
                const riesgo = sl - precioActual;
                const beneficio = precioActual - puntoA;

                if (riesgo > 0 && (beneficio / riesgo) >= rr) {
                    return {
                        accion: 'SHORT',
                        precioEntrada: precioActual,
                        sl: Number(sl.toFixed(2)),
                        tp: Number(puntoA.toFixed(2)),
                        motivo: 'Rechazo en resistencia de rango 4H con R:R válido'
                    };
                }
            }
        }

        return { accion: 'NINGUNA', precioEntrada: 0, sl: 0, tp: 0, motivo: 'Mercado sin confluencia técnica' };
    }
}