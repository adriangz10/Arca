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

/** CBU: 22 dígitos con sus dos dígitos verificadores (bloque banco/sucursal y bloque cuenta). */
export function validarCbu(cbu: string): boolean {
  const s = cbu.replace(/[^0-9]/g, '');
  if (s.length !== 22) return false;
  const dv = (digitos: string, pesos: number[]) => {
    const suma = digitos.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    return (10 - (suma % 10)) % 10;
  };
  const bloque1 = s.slice(0, 8);
  const bloque2 = s.slice(8);
  return (
    dv(bloque1.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(bloque1[7]) &&
    dv(bloque2.slice(0, 13), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === Number(bloque2[13])
  );
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
