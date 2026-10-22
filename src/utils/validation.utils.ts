export function validarCuit(cuit: number | string): boolean {
  const cuitStr = String(cuit).replace(/[^0-9]/g, '');
  if (cuitStr.length !== 11) return false;

  const multiplicadores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;

  for (let i = 0; i < 10; i++) {
    suma += parseInt(cuitStr[i]) * multiplicadores[i];
  }

  const resto = suma % 11;
  let digitoVerificador = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;

  if (resto === 1) {
    if (cuitStr[0] === '2' && cuitStr[1] === '0') {
      digitoVerificador = 9;
    } else if (cuitStr[0] === '2' && cuitStr[1] === '3') {
      digitoVerificador = 4;
    }
  }

  return digitoVerificador === parseInt(cuitStr[10]);
}

export function validarCbu(cbu: string): boolean {
  const cbuStr = cbu.replace(/[^0-9]/g, '');
  return cbuStr.length === 22;
}

export function validarEcuacionFiscal(neto: number, iva: number, trib: number, opEx: number, totConc: number, total: number): boolean {
  const sumaCalculada = Number((neto + iva + trib + opEx + totConc).toFixed(2));
  const totalRounded = Number(total.toFixed(2));
  return Math.abs(sumaCalculada - totalRounded) <= 0.01;
}

export function validarCoherenciaFechas(fechaDesde?: string, fechaHasta?: string): boolean {
  if (!fechaDesde || !fechaHasta) return true;
  
  if (fechaDesde.length !== 8 || fechaHasta.length !== 8) return false;

  const d1 = new Date(Number(fechaDesde.slice(0, 4)), Number(fechaDesde.slice(4, 6)) - 1, Number(fechaDesde.slice(6, 8)));
  const d2 = new Date(Number(fechaHasta.slice(0, 4)), Number(fechaHasta.slice(4, 6)) - 1, Number(fechaHasta.slice(6, 8)));

  return d1 <= d2;
}
