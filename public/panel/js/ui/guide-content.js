// Textos de la guía de cada pantalla. Idioma MUY simple, oraciones cortas, voseo.
// **texto** = negrita (se usa para los nombres de botones tal como aparecen en el panel).
//
// Estructura de cada guía:
//   title, art (dibujo principal), para (¿Para qué sirve?), pasos (Cómo se usa),
//   ideas (palabras del panel explicadas, con dibujo), si / no, listas (colores, números, tipos de alerta).
//   En las listas: tone = ok | warn | bad | n · kind = dot | num | pill.

export const GUIDES = {
  inicio: {
    title: 'Inicio',
    art: 'manda',
    artLabel: 'El número de Stock Central pasa solo a la tienda',
    para: [
      'Es la portada. De un vistazo ves si hay algún problema y cuánto stock tenés.',
      'Stock Central es el que manda: el número de acá es el verdadero. La tienda se actualiza sola desde acá.',
      'Cuando el panel dice **TN**, quiere decir Tiendanube (tu tienda).',
    ],
    pasos: [
      'Mirá arriba de todo. Si dice **Sin alertas** en verde, está todo bien.',
      'Si hay alertas, leé cada una. Tocá el botón de al lado (**Ver variante** o **Ver orden**) para ir al lugar del problema.',
      'Cuando ya lo arreglaste, tocá **Descartar** para sacarla de la lista.',
      'Tocá cualquier cuadro con número (por ejemplo **Sin stock**) para ver esa lista de prendas.',
      'Más abajo ves lo último que pasó: ventas, carritos y cambios.',
    ],
    ideas: [
      { art: 'campana', term: 'Alertas', text: 'Son avisos de algo que tenés que mirar. Las rojas son urgentes. Las amarillas son para tener en cuenta.' },
      { art: 'notienda', term: 'No toques el stock en Tiendanube', text: 'Si cambiás un número a mano en la tienda, se pisa con el de acá. Cambialo siempre en Stock Central.' },
    ],
    si: [
      'Mirá Inicio al empezar el día.',
      'Arreglá primero las alertas rojas.',
      'Descartá una alerta recién cuando ya la resolviste.',
    ],
    no: [
      'No descartes alertas sin leerlas: se van de la lista.',
      'No cambies el stock a mano en Tiendanube: se pisa con el de acá.',
      'No te preocupes por **Carrito rechazado** o **Diferencia con TN**: son solo avisos.',
    ],
    listas: [
      {
        title: 'Tipos de alerta',
        items: [
          { tone: 'bad', kind: 'pill', show: 'Sobreventa', text: 'Se vendió algo que no había. Revisá el pedido y avisale al cliente.' },
          { tone: 'warn', kind: 'pill', show: 'Venta sin vincular', text: 'Se vendió un producto de la tienda que no está conectado acá, así que no se descontó. Andá a Stock y vinculalo.' },
          { tone: 'bad', kind: 'pill', show: 'Error de sync', text: 'No se pudo actualizar la tienda. Abrí esa prenda y tocá **Sincronizar con TN** para reintentar.' },
          { tone: 'bad', kind: 'pill', show: 'Error de webhook', text: 'Falló un aviso de pedido que manda la tienda. Fijate en Actividad si ese pedido se descontó.' },
          { tone: 'warn', kind: 'pill', show: 'Carrito rechazado', text: 'Alguien quiso llevar algo sin stock. Es solo para que sepas.' },
          { tone: 'warn', kind: 'pill', show: 'Diferencia con TN', text: 'La tienda tenía otro número y se corrigió solo. Es solo para que sepas.' },
        ],
      },
      {
        title: '¿Qué significan los colores y números?',
        items: [
          { tone: 'ok', kind: 'dot', text: '**Verde**: todo bien. Hay stock o hubo ventas.' },
          { tone: 'warn', kind: 'dot', text: '**Amarillo**: atención. Queda poco (1 a 3) o está en carritos.' },
          { tone: 'bad', kind: 'dot', text: '**Rojo**: problema o sin stock (0).' },
          { tone: 'n', kind: 'dot', text: '**Gris**: dato para que sepas (último pedido, última revisión).' },
          { tone: 'ok', kind: 'num', show: '120', text: '**Unidades en stock**: todas las prendas que se pueden vender ahora.' },
          { tone: 'warn', kind: 'num', show: '2', text: '**En carritos**: prendas guardadas en carritos de clientes en este momento.' },
        ],
      },
    ],
  },

  stock: {
    title: 'Stock',
    art: 'disponible',
    artLabel: 'Una remera con un 2 grande: quedan 2 para vender',
    para: [
      'Acá están todas tus prendas y cuántas quedan de cada talle.',
      'Es el número verdadero: la tienda copia este número sola.',
    ],
    pasos: [
      'Buscá la prenda escribiendo el nombre o el talle en el buscador.',
      'Usá los botones de arriba para ver solo **Sin stock**, **Stock bajo** o **Con carrito**.',
      'Mirá el número grande de cada talle: es lo que se puede vender ahora.',
      'Para sumar o restar de a una, usá **−** y **+**. Para poner un número exacto, tocá **Fijar**.',
      'Tocá el nombre del talle para abrir su ficha: historial y productos de la tienda conectados.',
      '¿Prenda nueva? Tocá **Agregar producto** y elegila de la tienda.',
    ],
    ideas: [
      { art: 'disponible', term: 'Disponible (el número grande)', text: 'Lo que alguien puede comprar ahora mismo.' },
      { art: 'fisico', term: 'Físico', text: 'Lo que hay en el depósito. Aparece chiquito, abajo del número grande.' },
      { art: 'reservado', term: 'En carrito (reservado)', text: 'Está en el carrito de un cliente. Se guarda 15 minutos. Si no paga, vuelve solo. Disponible = Físico − En carrito.' },
      { art: 'compartido', term: 'Una prenda, varios diseños', text: 'Varios diseños pueden salir de la misma prenda. Por ejemplo, las remeras "I CRY A LOT" y "F*CK THE PATRIARCHY" usan la misma remera negra talle 4.' },
      { art: 'ultima', term: 'Si queda 1', text: 'Si queda 1 y alguien la pone en el carrito, los otros diseños se ven sin stock. Así no se vende 2 veces.' },
      { art: 'masmenos', term: '+1 y −1', text: 'Suman o restan una unidad al toque. La tienda se actualiza sola.' },
    ],
    si: [
      'Cuando entra mercadería, sumala acá.',
      'Contá el depósito de vez en cuando. Si no coincide, usá **Fijar**.',
      'Si dos diseños usan la misma prenda, conectalos a la misma prenda de acá.',
    ],
    no: [
      'No cambies el stock en Tiendanube: se borra y queda el de acá.',
      'No restes a mano cuando hay una venta: se descuenta solo.',
      'No sumes a mano cuando cancelan un pedido: vuelve solo.',
      'No borres una prenda que todavía se vende en la tienda.',
    ],
    listas: [
      {
        title: '¿Qué significan los colores y números?',
        items: [
          { tone: 'ok', kind: 'num', show: '8', text: '**Verde**: hay stock (4 o más).' },
          { tone: 'warn', kind: 'num', show: '2', text: '**Amarillo**: queda poco (1 a 3).' },
          { tone: 'bad', kind: 'num', show: '0', text: '**Rojo**: no queda nada. No se puede comprar.' },
          { tone: 'warn', kind: 'pill', show: 'Sin vincular', text: 'Ese talle no está conectado a ningún producto de la tienda. Las ventas no lo descuentan.' },
          { tone: 'bad', kind: 'pill', show: 'Error de sync', text: 'No se pudo actualizar la tienda. Abrí la ficha y tocá **Sincronizar con TN**.' },
          { tone: 'warn', kind: 'text', show: '· 1 en carrito', text: 'Hay unidades guardadas en carritos ahora.' },
        ],
      },
    ],
  },

  variante: {
    title: 'Ficha de un talle',
    art: 'vincular',
    artLabel: 'Una remera conectada con una cadena a la tienda',
    para: [
      'Es la ficha de un talle. Acá cambiás el stock con un motivo.',
      'También ves a qué productos de la tienda está conectado y todo lo que le pasó.',
    ],
    pasos: [
      'Arriba mirá los números: **Disponible**, **Físico** y **En carritos**.',
      'Para cambiar el stock elegí **Sumar**, **Restar** o **Fijar en**.',
      'Escribí la cantidad y un motivo (por ejemplo: "llegó mercadería").',
      'Tocá **Guardar**. La tienda se actualiza sola.',
      'En **En Tiendanube** ves los productos de la tienda conectados. Para sumar otro, tocá **Vincular otro producto de TN**.',
      'Abajo, en **Historial**, ves cada venta y cada cambio.',
    ],
    ideas: [
      { art: 'vincular', term: 'Vincular', text: 'Conectar un producto de la tienda con esta prenda. Así, cuando se vende, se descuenta de acá.' },
      { art: 'compartido', term: 'Diseños que comparten prenda', text: 'Si varios diseños usan esta misma prenda, vinculalos todos acá. No armes una prenda por cada diseño.' },
      { art: 'manda', term: 'Sincronizar con TN', text: 'Vuelve a mandar el número a la tienda (TN = Tiendanube). Usalo si ves "difiere" o un error en rojo.' },
    ],
    si: [
      'Poné siempre un motivo. Después sabés por qué cambió.',
      'Usá **Sumar** cuando entra mercadería.',
      'Usá **Fijar en** después de contar el depósito.',
    ],
    no: [
      'No vincules un producto a la prenda equivocada: va a descontar de otra.',
      'No desvincules algo que se sigue vendiendo: las ventas dejan de descontar.',
      'No borres el talle para "limpiar": perdés el historial.',
    ],
    listas: [
      {
        title: '¿Qué significan los colores y números?',
        items: [
          { tone: 'ok', kind: 'num', show: '5', text: '**Disponible**: lo que se puede comprar ahora.' },
          { tone: 'n', kind: 'num', show: '6', text: '**Físico**: lo que hay en el depósito.' },
          { tone: 'warn', kind: 'num', show: '1', text: '**En carritos**: guardado 15 minutos para un cliente.' },
          { tone: 'warn', kind: 'text', show: 'TN: 3 · difiere', text: 'La tienda muestra otro número. Tocá **Sincronizar con TN**.' },
          { tone: 'bad', kind: 'text', show: 'Ya no existe en Tiendanube', text: 'Ese producto se borró de la tienda. Desvinculalo.' },
        ],
      },
    ],
  },

  combos: {
    title: 'Combos',
    art: 'combo',
    artLabel: 'Dos buzos unidos: se venden juntos',
    para: [
      'Un combo son dos productos que se venden juntos (por ejemplo, buzo + pantalón).',
      'El combo tiene stock de cada par de talles, y se calcula solo.',
    ],
    pasos: [
      'Tocá **Nuevo combo**.',
      'Elegí el primer producto y después el segundo.',
      'Poné el nombre y el precio. Tocá **Crear combo**: se crea solo en la tienda.',
      'Tocá **Ver combinaciones** para ver cuántos hay de cada par de talles.',
      'Si un número no te cierra, tocá **Sincronizar** en ese combo (o **Actualizar todos**).',
    ],
    ideas: [
      { art: 'menor', term: 'El stock del combo', text: 'Es el del producto que menos tiene. Si hay 5 buzos y 2 pantalones, hay 2 combos.' },
      { art: 'fisico', term: 'Primero, cargados en Stock', text: 'Los dos productos tienen que estar cargados en Stock. Si no, el combo no sabe cuántos hay.' },
    ],
    si: [
      'Cargá primero los dos productos en Stock.',
      'Después de crear el combo, mirá sus combinaciones.',
      'Si cambiaste talles de un producto, usá **Agregar talles faltantes a combos** en Ajustes.',
    ],
    no: [
      'No cambies el stock del combo en la tienda: se calcula solo.',
      'No borres un combo que se está vendiendo: también se borra de la tienda.',
      'No armes un combo con un producto que no está en Stock.',
    ],
    listas: [
      {
        title: '¿Qué significan los colores y números?',
        items: [
          { tone: 'ok', kind: 'num', show: '12', text: '**Verde**: la mayoría de los pares de talles tiene stock.' },
          { tone: 'warn', kind: 'num', show: '4', text: '**Amarillo**: menos de la mitad tiene stock.' },
          { tone: 'bad', kind: 'num', show: '0', text: '**Rojo**: ningún par tiene stock, o hubo un error al actualizar la tienda.' },
          { tone: 'ok', kind: 'num', show: '∞', text: 'Sin límite: ese producto no lleva control de stock en la tienda.' },
        ],
      },
    ],
  },

  actividad: {
    title: 'Actividad',
    art: 'diario',
    artLabel: 'Una lista de tarjetas, una debajo de otra, con una rayita de color',
    para: [
      'Es el diario de todo lo que pasó: ventas, carritos, cambios de stock y problemas.',
      'Lo más nuevo aparece arriba.',
    ],
    pasos: [
      'Buscá por nombre del cliente, número de pedido o producto.',
      'Filtrá con los botones: **Ventas**, **Carritos**, **Ajustes** o **Problemas**.',
      'Cada tarjeta es un pedido o un cambio. Dice cuánto se sumó o restó y cuántas **quedan**.',
      'Tocá el nombre de una prenda para abrir su ficha.',
      'Al final, tocá **Cargar más** para ver cosas más viejas.',
    ],
    ideas: [
      { art: 'pedido', term: 'Las ventas se descuentan solas', text: 'Cuando entra el pedido, se resta solo. Si pagan por transferencia, se resta igual al entrar el pedido.' },
      { art: 'vuelve', term: 'Si cancelan, vuelve solo', text: 'Cuando se cancela un pedido, el stock vuelve solo. No hace falta sumarlo a mano.' },
      { art: 'reservado', term: 'Carritos', text: 'Alguien puso algo en el carrito. Se guarda 15 minutos. Si no paga, se libera solo.' },
    ],
    si: [
      'Usala para responder "¿por qué cambió este número?".',
      'Cuando un cliente reclama, buscá su número de pedido.',
    ],
    no: [
      'No corrijas a mano una venta que ya se descontó: se restaría dos veces.',
      'No prendas **Mostrar syncs** salvo que te lo pidan: muestra cada actualización de la tienda y llena la lista.',
    ],
    listas: [
      {
        title: '¿Qué significan los colores y números?',
        items: [
          { tone: 'ok', kind: 'dot', text: '**Raya verde**: una venta o un pago.' },
          { tone: 'warn', kind: 'dot', text: '**Raya amarilla**: un carrito o una corrección.' },
          { tone: 'bad', kind: 'dot', text: '**Raya roja**: un problema (sobreventa, carrito rechazado).' },
          { tone: 'n', kind: 'dot', text: '**Raya gris**: un cambio común (ajuste, carrito liberado).' },
          { tone: 'ok', kind: 'num', show: '+2', text: 'Se sumó al stock.' },
          { tone: 'n', kind: 'num', show: '−1', text: 'Se restó del stock.' },
        ],
      },
    ],
  },

  ajustes: {
    title: 'Ajustes',
    art: 'conectado',
    artLabel: 'El panel y la tienda conectados, con un tilde verde',
    para: [
      'Es la sala de máquinas: la conexión con la tienda y algunas tareas largas.',
      'Casi nunca hace falta tocar nada.',
    ],
    pasos: [
      'En **Conexión con Tiendanube**, mirá que los puntitos estén en verde. Si están verdes, no toques nada.',
      'Si dudás, tocá **Probar conexión**.',
      'Si dejan de llegar las ventas, andá al cuadro de avisos de pedidos (dice "Webhooks") y tocá **Limpiar y registrar**.',
      'En **Mantenimiento** hay tareas largas. Tocá **Ejecutar** y seguí usando el panel: corren solas.',
      'En **Copias de seguridad**, una vez por semana tocá **Descargar copia** y guardá el archivo en tu compu o en Drive.',
      'Si usaste una compu prestada, tocá **Cerrar sesión en este navegador**.',
    ],
    ideas: [
      { art: 'candado', term: 'Clave de administrador', text: 'El panel pide una clave para entrar. Es solo tuya: no la compartas.' },
      { art: 'tareas', term: 'Mantenimiento', text: 'Tareas largas. Se pueden dejar corriendo. Arriba aparece un aviso amarillo mientras trabajan.' },
      { art: 'conectado', term: 'Datos de la tienda', text: '"Store ID" y "Access token" son los datos que conectan el panel con tu tienda. Si funciona, no los cambies.' },
    ],
    si: [
      'Si los puntitos están en verde, dejá todo como está.',
      'Dejá correr las tareas hasta que terminen.',
      'Cerrá sesión si usaste una compu que no es tuya.',
      'Descargá una copia de seguridad cada tanto y guardala fuera del panel.',
    ],
    no: [
      'No cambies los datos de la tienda si funciona.',
      'No toques **Limpiar y registrar** si las ventas llegan bien.',
      'No compartas la clave del panel con nadie.',
      'No mandes el archivo de la copia por mail ni lo subas a lugares públicos: tiene los datos de tus clientes.',
      'No corras la misma tarea dos veces seguidas.',
    ],
    listas: [
      {
        title: '¿Qué significan los colores?',
        items: [
          { tone: 'ok', kind: 'dot', text: '**Verde**: conectado y funcionando.' },
          { tone: 'warn', kind: 'dot', text: '**Amarillo**: los avisos de pedidos no están activos. Tocá **Limpiar y registrar**.' },
          { tone: 'bad', kind: 'dot', text: '**Rojo**: la tienda no está conectada. Faltan los datos de la tienda.' },
        ],
      },
    ],
  },
};
