// @ts-check
/**
 * What Landgrab's phone page says, in English and German (the phone's
 * own choice, else the room's language). Territory and continent names
 * come from the world (`data/world.txt`).
 */

import { format } from "./i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  const de = lang === "de";
  const N = (/** @type {number} */ n) => f.n(n);
  return {
    ...f,
    otherLang: de ? "English" : "Deutsch",
    yourName: de ? "Dein Name" : "Your name",
    join: de ? "Mitspielen" : "Join",
    joinTitle: de ? "Wer erobert die Welt?" : "Who takes the world?",
    tagline: de ? "Plane geheim. Erobere laut." : "Plan in secret. Conquer out loud.",
    reconnecting: de ? "Verbindung weg … gleich wieder da" : "Connection lost … reconnecting",
    nameTaken: de ? "Den Namen hat schon jemand." : "Someone has that name already.",
    pickAnother: de ? "Nimm einen anderen Namen." : "Pick another name.",
    full: de ? "Das Spiel ist voll (sechs Leute)." : "The game is full (six players).",
    closed: de ? "Das Spiel läuft schon." : "The game is on already.",
    badKey: de ? "Der Link stimmt nicht. Scanne den Code noch mal." : "The link is wrong. Scan the code again.",
    noRoom: de ? "Das Spiel gibt es nicht mehr." : "That game is over.",
    kicked: de ? "Du wurdest aus dem Spiel genommen." : "You were removed from the game.",
    replaced: de ? "Du spielst jetzt auf einem anderen Gerät." : "You are playing on another device now.",
    roomClosed: de ? "Das Spiel ist vorbei. Danke fürs Spielen!" : "The game is over. Thanks for playing!",
    lookTv: de ? "Schau auf den Fernseher." : "Look at the TV.",
    // Lobby
    youreIn: de ? "Du bist dabei!" : "You're in!",
    generals: de ? "Feldherren" : "Generals",
    vip: "VIP",
    start: de ? "Los geht's" : "Start",
    vipWait: (/** @type {number} */ n) => (de ? f.p(n, { one: "Noch # Person fehlt.", other: "Noch # Leute fehlen." }) : f.p(n, { one: "Waiting for # more player.", other: "Waiting for # more players." })),
    vipReady: de ? "Alle da? Dann los!" : "Everyone here? Start!",
    waitVip: de ? "Der VIP startet das Spiel." : "The VIP starts the game.",
    settings: de ? "Einstellungen" : "Settings",
    roundsLabel: de ? "Runden" : "Rounds",
    planLabel: de ? "Zeit zum Planen" : "Time to plan",
    seconds: (/** @type {number} */ n) => `${n} s`,
    howTitle: de ? "So geht's" : "How to play",
    how: /** @type {[string, string][]} */ (
      de
        ? [
            ["Planen", "Alle gleichzeitig, geheim, auf dem Handy: Armeen verteilen, Angriffe und Märsche befehlen."],
            ["Zuschauen", "Der Fernseher spielt alle Befehle ab, einer nach dem anderen, mit Würfeln."],
            ["Gewinnen", "Ganze Kontinente bringen mehr Armeen. Die meisten Gebiete am Ende gewinnen."],
          ]
        : [
            ["Plan", "Everyone at once, in secret, on their phone: place armies, order attacks and marches."],
            ["Watch", "The TV plays every order out, one after the other, with dice."],
            ["Win", "Whole continents bring more armies. Most territories at the end wins."],
          ]
    ),
    waitRound: de ? "Du steigst nächste Runde als Rebell ein." : "You join next round as a rebel.",
    // Planning
    round: (/** @type {number} */ r, /** @type {number} */ of) => (de ? `Runde ${r}/${of}` : `Round ${r}/${of}`),
    stepPlace: de ? "Verteilen" : "Place",
    stepMove: de ? "Ziehen & Angreifen" : "Move & attack",
    placeN: (/** @type {number} */ n) => (de ? `${N(n)} verteilen` : `Place ${N(n)}`),
    leftN: (/** @type {number} */ n) => (de ? `noch ${N(n)}` : `${N(n)} left`),
    allPlaced: de ? "Alles verteilt" : "All placed",
    allPlacedNext: de ? "Weiter: Armeen losschicken." : "Next: send your armies.",
    tapOwn: de ? "Tippe auf eins deiner Gebiete." : "Tap one of your territories.",
    tapAgain: de ? "Noch mal tippen: +1" : "Tap it again: +1",
    threatNear: (/** @type {string} */ terr, /** @type {number} */ n) => (de ? `⚠ daneben ${terr} mit ${N(n)}` : `⚠ ${terr} next door has ${N(n)}`),
    nextMove: de ? "Weiter: Ziehen & Angreifen →" : "Next: move & attack →",
    backToPlace: (/** @type {number} */ n) => (de ? `← Noch ${N(n)} zu verteilen` : `← ${N(n)} still to place`),
    tapFrom: de ? "Tippe auf ein Gebiet, aus dem Armeen losziehen." : "Tap a territory to send armies from.",
    tapTarget: de ? "Jetzt einen Nachbarn antippen: angreifen oder hinziehen." : "Now tap a neighbour to attack or move there.",
    tapAttackFrom: de ? "Tippe auf dein Gebiet daneben: von dort angreifen." : "Tap your territory next to it to attack from there.",
    nothingFrom: (/** @type {string} */ terr) => (de ? `Aus ${terr} geht nichts: eine Armee bleibt immer.` : `Nothing to send from ${terr}: one army always stays.`),
    freeShort: (/** @type {number} */ n) => (de ? `${N(n)} frei` : `${N(n)} free`),
    ordersWord: (/** @type {number} */ n) => (de ? f.p(n, { one: "Befehl", other: "Befehle" }) : f.p(n, { one: "order", other: "orders" })),
    world: de ? "Welt" : "World",
    cash: (/** @type {number} */ n) => (de ? `3 Sterne einlösen: +${n}` : `Cash in 3 stars: +${n}`),
    cashed: (/** @type {number} */ n) => (de ? `Eingelöst: +${n}` : `Cashed in: +${n}`),
    rose: (/** @type {string} */ t) => (de ? `Aufstand! Du hast dir ${t} geholt.` : `Uprising! You rose in ${t}.`),
    armies: (/** @type {number} */ n) => (de ? f.p(n, { one: "# Armee", other: "# Armeen" }) : f.p(n, { one: "# army", other: "# armies" })),
    wild: de ? "Wildnis" : "Wild lands",
    you: de ? "Du" : "You",
    ordersFull: de ? "Mehr Befehle gehen nicht." : "No more orders fit.",
    noBorder: de ? "Keins deiner Gebiete grenzt hier an." : "None of your territories borders it.",
    attackWith: (/** @type {number} */ n) => (de ? `Mit ${N(n)} angreifen` : `Attack with ${N(n)}`),
    moveWith: (/** @type {number} */ n) => (de ? `${N(n)} verlegen` : `Move ${N(n)}`),
    half: de ? "Hälfte" : "Half",
    all: de ? "Alle" : "All",
    safe: de ? "Sicher" : "Safe",
    winChance: (/** @type {number} */ p, /** @type {string} */ word) => (de ? `${p} % Siegchance · ${word}` : `${p}% to win · ${word}`),
    odds: de ? { good: "gut", even: "offen", bad: "riskant" } : { good: "likely", even: "a toss-up", bad: "risky" },
    hopeless: de ? "kaum Chancen" : "long odds",
    placeAll: (/** @type {number} */ n) => (de ? `+${n} alle` : `+${n} all`),
    cancel: de ? "Abbrechen" : "Cancel",
    removeShort: de ? "Löschen" : "Remove",
    remove: de ? "Befehl löschen" : "Remove the order",
    ready: de ? "Fertig" : "Ready",
    readyLeft: (/** @type {number} */ n) => (de ? `${n} übrig: das Spiel verteilt sie` : `${n} left: the game places them`),
    readyDone: de ? "Fertig!" : "Ready!",
    readyChange: de ? "Tippen zum Ändern" : "Tap to change",
    whoReady: (/** @type {number} */ n, /** @type {number} */ of) => (de ? `${n} von ${of} fertig` : `${n} of ${of} ready`),
    close: de ? "Schließen" : "Close",
    // Battle
    battle: de ? "Schlacht" : "Battle",
    watchTv: de ? "Schau auf den Fernseher." : "Watch the TV.",
    onTv: de ? "Im Fernsehen" : "On the TV",
    lineUp: de ? "Die Armeen stellen sich auf …" : "The armies line up …",
    roundOver: de ? "Runde vorbei" : "Round over",
    nothingYet: de ? "Noch nichts von dir." : "Nothing of yours yet.",
    yourBattles: de ? "Deine Kämpfe" : "Your battles",
    standings: de ? "Stand" : "Standings",
    now: {
      place: de ? "Verstärkung landet" : "Reinforcements land",
      placeYou: (/** @type {number} */ n) => (de ? `+${n} für dich` : `+${n} for you`),
      move: (/** @type {string} */ p) => (de ? `${p} marschiert` : `${p} marches`),
      attack: (/** @type {string} */ p) => (de ? `${p} greift an` : `${p} attacks`),
      clash: de ? "Frontal-Zusammenstoß!" : "Head-on clash!",
      youAttack: de ? "Dein Angriff" : "Your attack",
      youDefend: de ? "Du wirst angegriffen" : "You're attacked",
      youMove: de ? "Dein Marsch" : "Your march",
      youClash: de ? "Du prallst zusammen" : "Your clash",
      taken: (/** @type {string} */ to) => (de ? `${to} erobert!` : `${to} taken!`),
      held: (/** @type {string} */ to) => (de ? `${to} hält stand` : `${to} holds`),
      youTook: de ? "Erobert!" : "Taken!",
      youFailed: de ? "Abgewehrt" : "Repelled",
      youHeld: de ? "Gehalten!" : "Held!",
      youLost: de ? "Verloren!" : "Lost!",
      marched: de ? "Angekommen" : "Arrived",
      bounced: de ? "Beide aufgerieben" : "Both wiped out",
    },
    tally: {
      took: de ? "erobert" : "taken",
      lost: de ? "verloren" : "lost",
      beat: de ? "besiegt" : "beaten",
    },
    feed: {
      place: (/** @type {string} */ to, /** @type {number} */ n) => `+${n} ${de ? "in" : "in"} ${to}`,
      move: (/** @type {string} */ from, /** @type {string} */ to, /** @type {number} */ n) => (de ? `${n} marschieren von ${from} nach ${to}` : `${n} marched from ${from} to ${to}`),
      took: (/** @type {string} */ to, /** @type {string} */ foe, /** @type {number} */ lost) => (de ? `${to} erobert (von ${foe}), ${lost} verloren` : `Took ${to} from ${foe}, lost ${lost}`),
      failed: (/** @type {string} */ to, /** @type {string} */ foe, /** @type {number} */ beat) => (de ? `Angriff auf ${to} (${foe}) gescheitert, ${beat} besiegt` : `Attack on ${to} (${foe}) failed, beat ${beat}`),
      held: (/** @type {string} */ to, /** @type {string} */ foe) => (de ? `${to} gegen ${foe} gehalten` : `Held ${to} against ${foe}`),
      lostLand: (/** @type {string} */ to, /** @type {string} */ foe) => (de ? `${to} an ${foe} verloren` : `Lost ${to} to ${foe}`),
      clashWon: (/** @type {string} */ foe, /** @type {number} */ lost) => (de ? `Zusammenstoß mit ${foe} gewonnen, ${lost} verloren` : `Won the clash with ${foe}, lost ${lost}`),
      clashLost: (/** @type {string} */ foe) => (de ? `Zusammenstoß mit ${foe} verloren` : `Lost the clash with ${foe}`),
      cancel: (/** @type {string} */ from, /** @type {string} */ to) => (de ? `${from} → ${to} fiel aus: ${from} war weg oder leer` : `${from} → ${to} called off: ${from} was lost or empty`),
      out: de ? "Du wurdest ausgelöscht! Nächste Runde kommst du als Rebell zurück." : "You were wiped out! You come back as a rebel next round.",
      continent: (/** @type {string} */ c) => (de ? `Ganz ${c} gehört dir!` : `All of ${c} is yours!`),
    },
    out: de ? "Ausgelöscht! Nächste Runde steigst du als Rebell wieder ein." : "Wiped out! You rise again as a rebel next round.",
    // The end
    won: de ? "Die Welt gehört dir!" : "The world is yours!",
    gameOver: de ? "Spiel vorbei" : "Game over",
    rank: (/** @type {number} */ r, /** @type {number} */ of) => (de ? `Platz ${r} von ${of}` : `Place ${r} of ${of}`),
    by: /** @type {Record<string, string>} */ (de ? { rounds: "Alle Runden gespielt", domination: "Weltherrschaft!", players: "Zu wenige Spieler übrig" } : { rounds: "All rounds played", domination: "World domination!", players: "Too few players left" }),
    lands: (/** @type {number} */ n) => (de ? f.p(n, { one: "# Gebiet", other: "# Gebiete" }) : f.p(n, { one: "# territory", other: "# territories" })),
    awardsTitle: de ? "Auszeichnungen" : "Awards",
    awards: /** @type {Record<string, [string, (n: number) => string]>} */ (
      de
        ? {
            conqueror: ["Eroberer", (n) => f.p(n, { one: "# Gebiet erobert", other: "# Gebiete erobert" })],
            warlord: ["Kriegsherr", (n) => f.p(n, { one: "# Gegner besiegt", other: "# Gegner besiegt" })],
            giant: ["Großschlacht", (n) => `${N(n)} in einem Kampf besiegt`],
            phoenix: ["Phönix", (n) => f.p(n, { one: "# Aufstand", other: "# Aufstände" })],
          }
        : {
            conqueror: ["Conqueror", (n) => f.p(n, { one: "# territory taken", other: "# territories taken" })],
            warlord: ["Warlord", (n) => f.p(n, { one: "# enemy army beaten", other: "# enemy armies beaten" })],
            giant: ["Giant slayer", (n) => `${N(n)} beaten in one fight`],
            phoenix: ["Phoenix", (n) => f.p(n, { one: "# uprising", other: "# uprisings" })],
          }
    ),
    playAgain: de ? "Noch mal" : "Play again",
    vipAgain: de ? "Der VIP startet die nächste Partie." : "The VIP starts the next game.",
    errors: /** @type {Record<string, string>} */ (
      de
        ? { "not-now": "Gerade nicht.", "too-many": "So viele Armeen hast du nicht.", "too-few-armies": "Eine Armee bleibt immer zurück.", "not-yours": "Das Gebiet gehört dir nicht mehr.", "not-neighbor": "Das grenzt nicht an.", "no-stars": "Dafür brauchst du drei Sterne.", "too-many-orders": "Mehr Befehle gehen nicht.", "too-few": "Es fehlen noch Leute.", "not-vip": "Nur der VIP darf das." }
        : { "not-now": "Not now.", "too-many": "You don't have that many armies.", "too-few-armies": "One army always stays behind.", "not-yours": "That territory isn't yours any more.", "not-neighbor": "That's not next to it.", "no-stars": "That takes three stars.", "too-many-orders": "No more orders fit.", "too-few": "Waiting for more players.", "not-vip": "Only the VIP can do that." }
    ),
  };
}

/** @typedef {ReturnType<typeof strings>} Strings */
