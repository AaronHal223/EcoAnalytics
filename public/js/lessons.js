// Lessons that teach a beginner one thing a day, in the order a first garden needs them,
// using their own garden's facts (frost dates, soil, sun, plants) wherever possible.
// Two lessons are open on day one and one more opens each day after.

const P = (ctx, k, d) => (ctx && ctx[k] != null && ctx[k] !== "" ? ctx[k] : d);

export const LESSONS = [
  { id: "start", title: { en: "How this works", es: "Cómo funciona" },
    en: c => `Each day, open Today. It tells you the few jobs that matter, using the weather where you are${P(c, "place", "") ? ` in ${c.place}` : ""}. Tick them off as you go. That's really all a garden needs: a little attention, often.`,
    es: c => `Cada día, abre Hoy. Te dice las pocas tareas que importan, según el tiempo donde vives${P(c, "place", "") ? ` en ${c.place}` : ""}. Márcalas al terminarlas. Eso es todo lo que un huerto necesita: un poco de atención, a menudo.`,
    try: { en: "Look at today's list and do one thing on it.", es: "Mira la lista de hoy y haz una cosa." } },
  { id: "sun", title: { en: "Sun is food", es: "El sol es alimento" },
    en: c => `Plants make their food from sunlight. Fruit like tomatoes and beans want 6 to 8 hours of direct sun; leaves like lettuce and kale manage with 4. You told us your spot gets about ${P(c, "sunHours", 8)} hours, so your plants were picked to match.`,
    es: c => `Las plantas fabrican su alimento con la luz del sol. Los frutos, como tomates y frijoles, quieren de 6 a 8 horas de sol directo; las hojas, como lechuga y col rizada, se arreglan con 4. Nos dijiste que tu lugar recibe unas ${P(c, "sunHours", 8)} horas, así que tus plantas se eligieron para eso.`,
    try: { en: "Notice when sun first hits your spot, and when it leaves.", es: "Fíjate cuándo llega el sol a tu lugar y cuándo se va." } },
  { id: "frost", title: { en: "Your frost dates", es: "Tus fechas de helada" },
    en: c => `Frost kills tender plants. Where you garden, the last spring frost is usually around ${P(c, "spring", "mid-spring")} and the first fall frost around ${P(c, "fall", "mid-fall")}. Lettuce, peas and kale can go in a few weeks before the last frost; tomatoes, beans and basil wait until after it.`,
    es: c => `La helada mata a las plantas delicadas. Donde vives, la última helada de primavera suele ser hacia ${P(c, "spring", "mediados de primavera")} y la primera de otoño hacia ${P(c, "fall", "mediados de otoño")}. Lechuga, guisantes y col rizada pueden plantarse unas semanas antes de la última helada; tomates, frijoles y albahaca esperan a que pase.`,
    try: { en: "Write your frost dates somewhere you'll see them.", es: "Anota tus fechas de helada donde las veas." } },
  { id: "soil", title: { en: "Your soil", es: "Tu suelo" },
    en: c => `Soil is the plant's pantry. Yours is ${P(c, "texture", "a mix of sand, silt and clay")}${P(c, "phWord", "") ? `, and it is ${c.phWord}` : ""}. You don't need to change much: a few inches of compost on top each year fixes most soils.`,
    es: c => `El suelo es la despensa de la planta. El tuyo es ${P(c, "textureEs", "una mezcla de arena, limo y arcilla")}${P(c, "phWordEs", "") ? `, y ${c.phWordEs}` : ""}. No hace falta cambiar mucho: unos centímetros de compost encima cada año arreglan casi cualquier suelo.`,
    try: { en: "Squeeze a handful of damp soil. Sticky = clay, gritty = sand.", es: "Aprieta un puñado de tierra húmeda. Pegajosa = arcilla, áspera = arena." } },
  { id: "water", title: { en: "Watering, the right way", es: "Regar bien" },
    en: () => "Water deeply, not daily: about 1 inch a week, rain included, so roots grow down where it stays damp. Water the soil, not the leaves, and in the morning if you can. Push a finger in: if it's dry 2 inches down, water.",
    es: () => "Riega a fondo, no a diario: unos 1 in por semana, contando la lluvia, para que las raíces bajen donde hay humedad. Riega la tierra, no las hojas, y por la mañana si puedes. Mete un dedo: si está seca a 2 in, riega.",
    try: { en: "Do the finger test today.", es: "Haz hoy la prueba del dedo." } },
  { id: "seeds", title: { en: "Planting seeds", es: "Sembrar semillas" },
    en: () => "The simple rule: plant a seed about twice as deep as it is wide. Tiny seeds like lettuce barely get covered; beans go in about an inch. Keep the soil damp until they sprout, usually in 5 to 10 days.",
    es: () => "La regla sencilla: siembra la semilla a una profundidad de unas dos veces su ancho. Las diminutas, como la lechuga, apenas se cubren; los frijoles van a unos 1 in. Mantén la tierra húmeda hasta que broten, normalmente en 5 a 10 días.",
    try: { en: "Read the back of a seed packet: it says depth and spacing.", es: "Lee el reverso de un sobre de semillas: dice profundidad y distancia." } },
  { id: "starts", title: { en: "Seeds or small plants?", es: "¿Semillas o plantitas?" },
    en: () => "Some plants are easiest from seed sown right in the ground: beans, peas, radishes, lettuce, zucchini. Others are easier bought as small plants: tomatoes, peppers and basil. A small plant costs a few dollars and skips the hardest weeks.",
    es: () => "Algunas plantas se siembran mejor directamente en la tierra: frijoles, guisantes, rábanos, lechuga, calabacín. Otras es mejor comprarlas como plantitas: tomates, pimientos y albahaca. Una plantita cuesta unos pocos dólares y se salta las semanas más difíciles.",
    try: { en: "Decide which of your plants you'll buy as small plants.", es: "Decide cuáles de tus plantas comprarás como plantitas." } },
  { id: "space", title: { en: "Give them room", es: "Dales espacio" },
    en: () => "Crowded plants fight for light and water and get sick more. A rough guide per square foot: 1 tomato needs 4 squares, 1 zucchini needs 9, but 4 lettuces or 9 bush beans fit in one. If seedlings come up too close, pull the extras.",
    es: () => "Las plantas apretadas compiten por luz y agua y enferman más. Una guía por pie cuadrado: 1 tomate necesita 4 cuadros, 1 calabacín 9, pero caben 4 lechugas o 9 matas de frijol en uno. Si brotan demasiado juntas, arranca las que sobran.",
    try: { en: "Open a plant in My Garden to see its spacing.", es: "Abre una planta en Mi huerto para ver su distancia." } },
  { id: "mulch", title: { en: "Mulch: a blanket for soil", es: "Acolchado: una manta para la tierra" },
    en: () => "Cover bare soil around plants with 2 inches of straw, shredded leaves or wood chips. It keeps water in, keeps weeds out and feeds the soil as it rots. It's the single laziest thing that helps most.",
    es: () => "Cubre la tierra desnuda alrededor de las plantas con 2 in de paja, hojas trituradas o astillas. Guarda el agua, frena las malas hierbas y alimenta el suelo al pudrirse. Es lo más fácil que más ayuda.",
    try: { en: "Save fallen leaves in a bag to use as mulch.", es: "Guarda hojas caídas en una bolsa para usarlas de acolchado." } },
  { id: "compost", title: { en: "Compost", es: "Compost" },
    en: () => "Compost is rotted plant scraps, and it's the best food for soil. Pile vegetable peels, coffee grounds, leaves and grass clippings; keep it damp; turn it now and then. In a few months it's dark and crumbly. No meat or dairy.",
    es: () => "El compost son restos vegetales podridos, y es el mejor alimento para el suelo. Amontona cáscaras de verdura, posos de café, hojas y césped cortado; mantenlo húmedo; voltéalo de vez en cuando. En unos meses queda oscuro y suelto. Sin carne ni lácteos.",
    try: { en: "Start a scrap bowl in the kitchen this week.", es: "Empieza esta semana un recipiente de restos en la cocina." } },
  { id: "feed", title: { en: "Feeding plants", es: "Alimentar las plantas" },
    en: () => "Leafy plants want nitrogen; fruiting plants want a balanced feed once they flower. Too much makes big leaves and little fruit. Compost plus a little all-purpose organic fertilizer, as the label says, is plenty.",
    es: () => "Las plantas de hoja quieren nitrógeno; las de fruto quieren un abono equilibrado cuando florecen. Demasiado da hojas grandes y poco fruto. Compost más un poco de abono orgánico de uso general, según la etiqueta, es suficiente.",
    try: { en: "Pale yellow leaves at the bottom? That's often hunger.", es: "¿Hojas amarillo pálido abajo? A menudo es hambre." } },
  { id: "weeds", title: { en: "Weeds", es: "Malas hierbas" },
    en: () => "Weeds are easiest while tiny. Five minutes twice a week beats an hour once a month. Pull them after rain when the soil is soft, and get the root.",
    es: () => "Las malas hierbas se quitan mejor cuando son pequeñas. Cinco minutos dos veces por semana es mejor que una hora al mes. Arráncalas después de llover, con la tierra blanda, y saca la raíz.",
    try: { en: "Do a five-minute weed walk.", es: "Da una vuelta de cinco minutos quitando hierbas." } },
  { id: "pests", title: { en: "Bugs: look under the leaves", es: "Bichos: mira bajo las hojas" },
    en: () => "Most pests hide on the underside of leaves. Check a few leaves each time you water. Pick off big bugs, spray small ones off with water, and leave ladybugs alone: they eat the bad ones. Photos help: Ask can look at one for you.",
    es: () => "La mayoría de las plagas se esconden bajo las hojas. Revisa algunas cada vez que riegues. Quita a mano los bichos grandes, quita los pequeños con un chorro de agua y deja en paz a las mariquitas: se comen a los malos. Las fotos ayudan: Preguntar puede mirar una por ti.",
    try: { en: "Turn over three leaves today and look.", es: "Da vuelta hoy a tres hojas y mira." } },
  { id: "harvest", title: { en: "Pick early, pick often", es: "Cosecha pronto y a menudo" },
    en: () => "Most plants make more when you pick. Beans, zucchini and herbs slow down if fruit is left on. Pick in the morning when it's cool, and log it in My Garden to see what your garden is worth.",
    es: () => "La mayoría de las plantas producen más si cosechas. Frijoles, calabacines y hierbas frenan si dejas el fruto. Cosecha por la mañana, cuando hace fresco, y anótalo en Mi huerto para ver cuánto vale tu huerto.",
    try: { en: "Log your next harvest, even a handful.", es: "Anota tu próxima cosecha, aunque sea un puñado." } },
  { id: "succession", title: { en: "Plant a little, often", es: "Siembra poco y a menudo" },
    en: () => "Instead of sowing all your lettuce at once, sow a short row every 2 to 3 weeks. You get a steady supply instead of everything at once and then nothing.",
    es: () => "En vez de sembrar toda la lechuga de una vez, siembra una hilera corta cada 2 o 3 semanas. Tendrás un suministro constante en vez de todo a la vez y luego nada.",
    try: { en: "Keep some seed back for a second sowing.", es: "Guarda semillas para una segunda siembra." } },
  { id: "harden", title: { en: "Toughen up small plants", es: "Endurece las plantitas" },
    en: () => "Plants grown indoors or bought from a store need a week to get used to outdoors. Set them outside in shade for an hour, then a bit longer each day, before planting. It stops them wilting and scorching.",
    es: () => "Las plantas criadas dentro o compradas en tienda necesitan una semana para acostumbrarse al exterior. Sácalas a la sombra una hora y un poco más cada día antes de plantarlas. Así no se marchitan ni se queman.",
    try: { en: "If you bought plants, start their outdoor week.", es: "Si compraste plantas, empieza su semana al aire libre." } },
  { id: "neighbours", title: { en: "Good neighbours", es: "Buenos vecinos" },
    en: () => "Tall plants shade short ones, so put tall plants on the side away from the midday sun. Some pairs share diseases, like tomatoes and potatoes. Herbs and flowers near vegetables bring helpful insects.",
    es: () => "Las plantas altas dan sombra a las bajas, así que ponlas del lado contrario al sol del mediodía. Algunas parejas comparten enfermedades, como tomates y papas. Hierbas y flores cerca de las verduras atraen insectos útiles.",
    try: { en: "Plant a few flowers at the end of a bed.", es: "Planta unas flores al final de un cantero." } },
  { id: "rotate", title: { en: "Move things around", es: "Cambia de sitio" },
    en: () => "Don't grow the same family in the same spot every year: diseases build up in the soil. Tomatoes, peppers and potatoes are one family; cabbage, kale and broccoli are another. Swap spots each year.",
    es: () => "No cultives la misma familia en el mismo sitio cada año: las enfermedades se acumulan en el suelo. Tomates, pimientos y papas son una familia; repollo, col rizada y brócoli son otra. Cambia de sitio cada año.",
    try: { en: "Note in your diary where each plant grew this year.", es: "Anota en tu diario dónde creció cada planta este año." } },
  { id: "cold", title: { en: "Cheating the cold", es: "Engañar al frío" },
    en: c => `A light cloth (row cover) or even an old sheet over plants on a frosty night keeps them a few degrees warmer. Take it off in the morning. It can stretch your season past ${P(c, "fall", "the first fall frost")} by weeks.`,
    es: c => `Una tela ligera (manta térmica) o incluso una sábana vieja sobre las plantas en una noche de helada las mantiene unos grados más calientes. Quítala por la mañana. Puede alargar tu temporada más allá de ${P(c, "fall", "la primera helada de otoño")} varias semanas.`,
    try: { en: "Find an old sheet to keep for frosty nights.", es: "Busca una sábana vieja para las noches de helada." } },
  { id: "fall", title: { en: "Fall planting", es: "Plantar en otoño" },
    en: () => "Fall is a second spring. Lettuce, spinach, kale and radishes love cool weather, and garlic planted in fall is ready next summer. Fewer bugs, less watering.",
    es: () => "El otoño es una segunda primavera. Lechuga, espinaca, col rizada y rábanos aman el fresco, y el ajo plantado en otoño está listo el verano siguiente. Menos bichos, menos riego.",
    try: { en: "Check My Garden for what you can plant this fall.", es: "Mira en Mi huerto qué puedes plantar este otoño." } },
  { id: "seedsave", title: { en: "Saving seeds", es: "Guardar semillas" },
    en: () => "Beans, peas, lettuce and tomatoes are easy to save seed from. Let a few go fully ripe or dry on the plant, collect the seeds, dry them on paper and keep them in an envelope somewhere cool. Free plants next year.",
    es: () => "De frijoles, guisantes, lechuga y tomates es fácil guardar semillas. Deja que algunos maduren o se sequen del todo en la planta, recoge las semillas, sécalas sobre papel y guárdalas en un sobre en un lugar fresco. Plantas gratis el año que viene.",
    try: { en: "Leave one bean pod to dry on the plant.", es: "Deja una vaina de frijol secarse en la planta." } },
  { id: "notes", title: { en: "Keep a diary", es: "Lleva un diario" },
    en: () => "The best gardeners write things down: what they planted, when, what worked. Your diary already writes a daily note for you; add a line of your own when something happens. Next year it's your own guidebook.",
    es: () => "Los mejores jardineros lo anotan todo: qué plantaron, cuándo, qué funcionó. Tu diario ya escribe una nota diaria por ti; añade una línea tuya cuando pase algo. El año que viene será tu propia guía.",
    try: { en: "Add a diary note about how your garden looks today.", es: "Añade una nota sobre cómo se ve tu huerto hoy." } },
  { id: "share", title: { en: "Ask other growers", es: "Pregunta a otros jardineros" },
    en: () => "Every gardener loses plants. The Community tab is for sharing what's happening, good and bad, and learning from people growing near you. Be kind and you'll get kindness back.",
    es: () => "Todo jardinero pierde plantas. La pestaña Comunidad es para contar lo que pasa, bueno y malo, y aprender de quienes cultivan cerca de ti. Sé amable y recibirás amabilidad.",
    try: { en: "Share one thing that went well, or didn't.", es: "Comparte algo que salió bien, o mal." } },
  { id: "graduate", title: { en: "You know the basics", es: "Ya sabes lo básico" },
    en: () => "You've learned what most gardening books take a hundred pages to say. When you're curious about the numbers, Advanced mode shows your exact soil test, costs, water use and the best crops for your yard. You can switch back any time.",
    es: () => "Ya aprendiste lo que muchos libros de jardinería tardan cien páginas en decir. Cuando tengas curiosidad por los números, el modo Avanzado muestra tu análisis de suelo, costos, agua y los mejores cultivos para tu patio. Puedes volver cuando quieras.",
    try: { en: "Peek at Advanced mode.", es: "Echa un vistazo al modo Avanzado." }, advanced: true },
];

export const LESSON_IDS = LESSONS.map(l => l.id);
const DAY = 864e5;

/** How many lessons are open: two on day one, then one more each day. */
export function unlockedCount(startedISO, today = new Date()) {
  if (!startedISO) return 2;
  const days = Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(startedISO + "T00:00:00")) / DAY);
  return Math.min(LESSONS.length, 2 + Math.max(0, days));
}

/** The lesson to show now: the first open one not yet done, or null (with when the next opens). */
export function currentLesson(progress = {}, today = new Date()) {
  const done = new Set(progress.done || []), open = unlockedCount(progress.started, today);
  const i = LESSONS.findIndex((l, k) => k < open && !done.has(l.id));
  if (i >= 0) return { lesson: LESSONS[i], index: i, open, done: done.size };
  return { lesson: null, index: -1, open, done: done.size, finished: done.size >= LESSONS.length };
}

/** A lesson's text for this garden and language. */
export function lessonText(lesson, ctx = {}, lang = "en") {
  const L = lang === "es" ? "es" : "en";
  return { title: lesson.title[L], body: lesson[L](ctx), try: lesson.try?.[L] || "" };
}

/** The garden facts lessons mention, from the app's research. */
export function lessonContext({ place, climate, soil, sunHours }) {
  const ph = soil?.values?.ph?.value;
  const phWord = !Number.isFinite(ph) ? "" : ph < 5.8 ? "on the sour (acidic) side, so a little garden lime helps" : ph > 7.5 ? "on the chalky (alkaline) side, so compost and a little sulfur help" : "just right for most vegetables";
  const phWordEs = !Number.isFinite(ph) ? "" : ph < 5.8 ? "es algo ácido, así que un poco de cal agrícola ayuda" : ph > 7.5 ? "es algo alcalino, así que compost y un poco de azufre ayudan" : "está justo bien para la mayoría de las verduras";
  const tex = String(soil?.texture_class || "").toLowerCase();
  return {
    place: place || "", spring: climate?.last_spring_frost || "", fall: climate?.first_fall_frost || "",
    ph, phWord, phWordEs, textureEs: tex ? (/clay/.test(tex) ? "arcilloso" : /sand/.test(tex) ? "arenoso" : "franco (suelto y equilibrado)") : "", texture: tex ? `${/clay/.test(tex) ? "clay-rich" : /sand/.test(tex) ? "sandy" : "loamy"} (${tex})` : "",
    sunHours: Number.isFinite(sunHours) ? Math.round(sunHours) : 8,
  };
}
