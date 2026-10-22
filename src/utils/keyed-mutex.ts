/**
 * Mutex en memoria por clave. Garantiza que las tareas con la misma clave
 * corran de a una (concurrencia = 1), en orden de llegada.
 *
 * Se usa para:
 *  - Serializar la emisión por Punto de Venta (evita que dos pedidos lean el
 *    mismo "último comprobante" y ARCA rechace uno por numeración).
 *  - Procesar de a un mensaje por teléfono (evita doble emisión si el usuario
 *    toca dos veces el botón "Emitir").
 *
 * Alcanza para un único proceso Node. Si se escala a varias instancias hay que
 * reemplazarlo por un lock distribuido (Redis/Redlock o BullMQ).
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  public async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);

    try {
      return await current;
    } finally {
      // Limpia la entrada si nadie más se encoló detrás.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

/** Lock global de emisión por Punto de Venta (compartido entre API REST y bot). */
export const emissionMutex = new KeyedMutex();
