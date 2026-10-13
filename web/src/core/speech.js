/**
 * LAS CONVERT — Audio → Text (Word-for-Word Transcription & Translation Engine)
 * Ultra high-fidelity speech recognition, sub-second word timecodes, instant word-to-word translation,
 * native TTS pronunciation, real-time karaoke synchronization, and bilingual subtitle exporting.
 */

// Offline comprehensive multi-language translation lexicon
// Supports: English (en), Spanish (es), French (fr), German (de), Yoruba (yo), Hausa (ha), Igbo (ig),
// Arabic (ar), Chinese (zh), Japanese (ja), Portuguese (pt), Italian (it), Russian (ru)
const LEXICON = {
  // Greetings & Conversational
  hello: { es: 'hola', fr: 'bonjour', de: 'hallo', yo: 'bawo', ha: 'sannu', ig: 'nnoo', ar: 'مرحبا', zh: '你好', ja: 'こんにちは', pt: 'olá', it: 'ciao', ru: 'привет' },
  hi: { es: 'hola', fr: 'salut', de: 'hi', yo: 'bawo', ha: 'sannu', ig: 'ndewo', ar: 'أهلاً', zh: '嗨', ja: 'やあ', pt: 'oi', it: 'ciao', ru: 'привет' },
  welcome: { es: 'bienvenido', fr: 'bienvenue', de: 'willkommen', yo: 'eku abo', ha: 'barka da zuwa', ig: 'nnoo', ar: 'أهلاً وسهلاً', zh: '欢迎', ja: 'ようこそ', pt: 'bem-vindo', it: 'benvenuto', ru: 'добро пожаловать' },
  goodbye: { es: 'adiós', fr: 'au revoir', de: 'auf wiedersehen', yo: 'odabo', ha: 'sai anjima', ig: 'ka omesia', ar: 'وداعاً', zh: '再见', ja: 'さようなら', pt: 'adeus', it: 'arrivederci', ru: 'до свидания' },
  bye: { es: 'adiós', fr: 'salut', de: 'tschüss', yo: 'odabo', ha: 'sai anjima', ig: 'ka omesia', ar: 'مع السلامة', zh: '拜拜', ja: 'じゃあね', pt: 'tchau', it: 'ciao', ru: 'пока' },
  please: { es: 'por favor', fr: 's\'il vous plaît', de: 'bitte', yo: 'jọwọ', ha: 'don Allah', ig: 'biko', ar: 'من فضلك', zh: '请', ja: 'お願いします', pt: 'por favor', it: 'per favore', ru: 'пожалуйста' },
  thank: { es: 'gracias', fr: 'merci', de: 'danke', yo: 'oṣe', ha: 'na gode', ig: 'daalu', ar: 'شكراً', zh: '谢谢', ja: 'ありがとう', pt: 'obrigado', it: 'grazie', ru: 'спасибо' },
  thanks: { es: 'gracias', fr: 'merci', de: 'danke', yo: 'ẹ ṣe', ha: 'godiya', ig: 'ndewo', ar: 'شكراً', zh: '多谢', ja: 'どうも', pt: 'obrigado', it: 'grazie', ru: 'спасибо' },
  yes: { es: 'sí', fr: 'oui', de: 'ja', yo: 'bẹẹni', ha: 'i', ig: 'ee', ar: 'نعم', zh: '是', ja: 'はい', pt: 'sim', it: 'sì', ru: 'да' },
  no: { es: 'no', fr: 'non', de: 'nein', yo: 'rara', ha: 'a\'a', ig: 'mba', ar: 'لا', zh: '不', ja: 'いいえ', pt: 'não', it: 'no', ru: 'нет' },
  ok: { es: 'bien', fr: 'd\'accord', de: 'in ordnung', yo: 'o da', ha: 'to', ig: 'ọ dị mma', ar: 'حسناً', zh: '好的', ja: '了解', pt: 'ok', it: 'ok', ru: 'хорошо' },
  okay: { es: 'de acuerdo', fr: 'd\'accord', de: 'okay', yo: 'o da', ha: 'to', ig: 'ọ dị mma', ar: 'حسناً', zh: '好', ja: 'オッケー', pt: 'tudo bem', it: 'va bene', ru: 'ладно' },
  help: { es: 'ayuda', fr: 'aide', de: 'hilfe', yo: 'iranlọwọ', ha: 'taimako', ig: 'enyemaka', ar: 'مساعدة', zh: '帮助', ja: '助け', pt: 'ajuda', it: 'aiuto', ru: 'помощь' },
  good: { es: 'bueno', fr: 'bon', de: 'gut', yo: 'dara', ha: 'mai kyau', ig: 'ọma', ar: 'جيد', zh: '好', ja: '良い', pt: 'bom', it: 'buono', ru: 'хороший' },
  great: { es: 'estupendo', fr: 'génial', de: 'großartig', yo: 'nla', ha: 'mai girma', ig: 'oke', ar: 'عظيم', zh: '极好', ja: '素晴らしい', pt: 'ótimo', it: 'ottimo', ru: 'великолепный' },
  bad: { es: 'malo', fr: 'mauvais', de: 'schlecht', yo: 'buburu', ha: 'marar kyau', ig: 'ọjọọ', ar: 'سيء', zh: '坏', ja: '悪い', pt: 'mau', it: 'cattivo', ru: 'плохой' },
  day: { es: 'día', fr: 'jour', de: 'tag', yo: 'ọjọ', ha: 'rana', ig: 'ụbọchị', ar: 'يوم', zh: '天', ja: '日', pt: 'dia', it: 'giorno', ru: 'день' },
  night: { es: 'noche', fr: 'nuit', de: 'nacht', yo: 'alẹ', ha: 'dare', ig: 'abalị', ar: 'ليل', zh: '晚上', ja: '夜', pt: 'noite', it: 'notte', ru: 'ночь' },
  morning: { es: 'mañana', fr: 'matin', de: 'morgen', yo: 'aarọ', ha: 'safiya', ig: 'ụtụtụ', ar: 'صباح', zh: '早上', ja: '朝', pt: 'manhã', it: 'mattina', ru: 'утро' },
  afternoon: { es: 'tarde', fr: 'après-midi', de: 'nachmittag', yo: 'ọsan', ha: 'rana', ig: 'ehihie', ar: 'بعد الظهر', zh: '下午', ja: '午後', pt: 'tarde', it: 'pomeriggio', ru: 'день' },
  evening: { es: 'tarde-noche', fr: 'soirée', de: 'abend', yo: 'irọlẹ', ha: 'yamma', ig: 'anyasị', ar: 'مساء', zh: '傍晚', ja: '夕方', pt: 'noite', it: 'sera', ru: 'вечер' },

  // Pronouns & Demonstratives
  i: { es: 'yo', fr: 'je', de: 'ich', yo: 'emi', ha: 'ni', ig: 'mụ', ar: 'أنا', zh: '我', ja: '私', pt: 'eu', it: 'io', ru: 'я' },
  you: { es: 'tú', fr: 'vous', de: 'du', yo: 'iwọ', ha: 'kai', ig: 'gị', ar: 'أنت', zh: '你', ja: 'あなた', pt: 'você', it: 'tu', ru: 'ты' },
  he: { es: 'él', fr: 'il', de: 'er', yo: 'oun', ha: 'shi', ig: 'ọ ya', ar: 'هو', zh: '他', ja: '彼', pt: 'ele', it: 'lui', ru: 'он' },
  she: { es: 'ella', fr: 'elle', de: 'sie', yo: 'oun', ha: 'ita', ig: 'ọ ya nwanyi', ar: 'هي', zh: '她', ja: '彼女', pt: 'ela', it: 'lei', ru: 'она' },
  it: { es: 'eso', fr: 'il', de: 'es', yo: 'o', ha: 'shi', ig: 'ọ', ar: 'هو', zh: '它', ja: 'それ', pt: 'isto', it: 'esso', ru: 'оно' },
  we: { es: 'nosotros', fr: 'nous', de: 'wir', yo: 'awa', ha: 'mu', ig: 'anyị', ar: 'نحن', zh: '我们', ja: '私たち', pt: 'nós', it: 'noi', ru: 'мы' },
  they: { es: 'ellos', fr: 'ils', de: 'sie', yo: 'wọn', ha: 'su', ig: 'ha', ar: 'هم', zh: '他们', ja: '彼ら', pt: 'eles', it: 'loro', ru: 'они' },
  this: { es: 'esto', fr: 'ceci', de: 'dies', yo: 'eyi', ha: 'wannan', ig: 'nke a', ar: 'هذا', zh: '这个', ja: 'これ', pt: 'isto', it: 'questo', ru: 'это' },
  that: { es: 'eso', fr: 'cela', de: 'das', yo: 'iyẹn', ha: 'wancan', ig: 'nke ahụ', ar: 'ذلك', zh: '那个', ja: 'それ', pt: 'isso', it: 'quello', ru: 'то' },
  these: { es: 'estos', fr: 'ces', de: 'diese', yo: 'wọnyi', ha: 'waɗannan', ig: 'ndị a', ar: 'هؤلاء', zh: '这些', ja: 'これら', pt: 'estes', it: 'questi', ru: 'эти' },
  those: { es: 'esos', fr: 'ceux-là', de: 'jene', yo: 'wọnyẹn', ha: 'waɗancan', ig: 'ndị ahụ', ar: 'أولئك', zh: '那些', ja: 'あれら', pt: 'aqueles', it: 'quelli', ru: 'те' },

  // Prepositions & Articles & Conjunctions
  to: { es: 'a', fr: 'à', de: 'zu', yo: 'si', ha: 'zuwa', ig: 'na', ar: 'إلى', zh: '到', ja: 'へ', pt: 'para', it: 'a', ru: 'к' },
  the: { es: 'el', fr: 'le', de: 'die', yo: 'naa', ha: 'wannan', ig: 'nke', ar: 'ال', zh: '这', ja: 'その', pt: 'o', it: 'il', ru: 'этот' },
  a: { es: 'un', fr: 'un', de: 'ein', yo: 'kan', ha: 'wani', ig: 'otu', ar: 'واحد', zh: '一个', ja: '一つの', pt: 'um', it: 'un', ru: 'один' },
  an: { es: 'un', fr: 'un', de: 'ein', yo: 'kan', ha: 'wani', ig: 'otu', ar: 'واحد', zh: '一个', ja: '一つの', pt: 'um', it: 'un', ru: 'один' },
  and: { es: 'y', fr: 'et', de: 'und', yo: 'ati', ha: 'da', ig: 'na', ar: 'و', zh: '和', ja: 'と', pt: 'e', it: 'e', ru: 'и' },
  or: { es: 'o', fr: 'ou', de: 'oder', yo: 'tabi', ha: 'ko', ig: 'ma ọ bụ', ar: 'أو', zh: '或者', ja: 'または', pt: 'ou', it: 'o', ru: 'или' },
  but: { es: 'pero', fr: 'mais', de: 'aber', yo: 'ṣugbọn', ha: 'amma', ig: 'mana', ar: 'لكن', zh: '但是', ja: 'しかし', pt: 'mas', it: 'ma', ru: 'но' },
  in: { es: 'en', fr: 'dans', de: 'in', yo: 'ninu', ha: 'a cikin', ig: 'ime', ar: 'في', zh: '在', ja: 'で', pt: 'em', it: 'in', ru: 'в' },
  on: { es: 'en', fr: 'sur', de: 'auf', yo: 'lori', ha: 'akan', ig: 'na elu', ar: 'على', zh: '上', ja: 'の上', pt: 'sobre', it: 'su', ru: 'на' },
  at: { es: 'en', fr: 'à', de: 'bei', yo: 'ni', ha: 'a', ig: 'na', ar: 'في', zh: '在', ja: 'で', pt: 'em', it: 'a', ru: 'в' },
  with: { es: 'con', fr: 'avec', de: 'mit', yo: 'pẹlu', ha: 'tare da', ig: 'na', ar: 'مع', zh: '与', ja: 'と共に', pt: 'com', it: 'con', ru: 'с' },
  for: { es: 'para', fr: 'pour', de: 'für', yo: 'fun', ha: 'don', ig: 'maka', ar: 'لأجل', zh: '为了', ja: 'のために', pt: 'para', it: 'per', ru: 'для' },
  from: { es: 'de', fr: 'de', de: 'von', yo: 'lati', ha: 'daga', ig: 'site na', ar: 'من', zh: '来自', ja: 'から', pt: 'de', it: 'da', ru: 'из' },
  by: { es: 'por', fr: 'par', de: 'von', yo: 'nipasẹ', ha: 'ta', ig: 'site na', ar: 'بواسطة', zh: '由', ja: 'によって', pt: 'por', it: 'da', ru: 'через' },
  about: { es: 'sobre', fr: 'environ', de: 'über', yo: 'nipa', ha: 'game da', ig: 'banyere', ar: 'حول', zh: '关于', ja: 'について', pt: 'sobre', it: 'circa', ru: 'о' },
  into: { es: 'en', fr: 'dans', de: 'in', yo: 'sinu', ha: 'cikin', ig: 'banye', ar: 'إلى داخل', zh: '进入', ja: '中へ', pt: 'em', it: 'in', ru: 'внутрь' },
  through: { es: 'a través de', fr: 'à travers', de: 'durch', yo: 'nipasẹ', ha: 'ta hanyar', ig: 'site na', ar: 'من خلال', zh: '通过', ja: 'を通して', pt: 'através', it: 'attraverso', ru: 'через' },

  // Auxiliary & Common Verbs
  is: { es: 'es', fr: 'est', de: 'ist', yo: 'jẹ', ha: 'ne', ig: 'bụ', ar: 'هو', zh: '是', ja: 'です', pt: 'é', it: 'è', ru: 'является' },
  am: { es: 'soy', fr: 'suis', de: 'bin', yo: 'jẹ', ha: 'ne', ig: 'bụ', ar: 'أنا', zh: '是', ja: 'です', pt: 'sou', it: 'sono', ru: 'есмь' },
  are: { es: 'son', fr: 'sont', de: 'sind', yo: 'jẹ', ha: 'ne', ig: 'bụ', ar: 'هم', zh: '是', ja: 'です', pt: 'são', it: 'sono', ru: 'являются' },
  was: { es: 'era', fr: 'était', de: 'war', yo: 'ti jẹ', ha: 'ya kasance', ig: 'bụrụ', ar: 'كان', zh: '是（过去）', ja: 'だった', pt: 'era', it: 'era', ru: 'был' },
  were: { es: 'eran', fr: 'étaient', de: 'waren', yo: 'ti jẹ', ha: 'sun kasance', ig: 'bụrụ', ar: 'كانوا', zh: '是（复数过去）', ja: 'だった', pt: 'eram', it: 'erano', ru: 'были' },
  be: { es: 'ser', fr: 'être', de: 'sein', yo: 'jẹ', ha: 'zama', ig: 'bụrụ', ar: 'يكون', zh: '存在', ja: 'ある', pt: 'ser', it: 'essere', ru: 'быть' },
  have: { es: 'tener', fr: 'avoir', de: 'haben', yo: 'ni', ha: 'da', ig: 'nwere', ar: 'يملك', zh: '有', ja: '持っている', pt: 'ter', it: 'avere', ru: 'иметь' },
  has: { es: 'tiene', fr: 'a', de: 'hat', yo: 'ni', ha: 'yana da', ig: 'nwere', ar: 'لديه', zh: '有', ja: '持っている', pt: 'tem', it: 'ha', ru: 'имеет' },
  had: { es: 'tenía', fr: 'avait', de: 'hatte', yo: 'ti ni', ha: 'yana da', ig: 'nwere', ar: 'كان لديه', zh: '曾有', ja: '持っていた', pt: 'tinha', it: 'aveva', ru: 'имел' },
  do: { es: 'hacer', fr: 'faire', de: 'tun', yo: 'ṣe', ha: 'yi', ig: 'mee', ar: 'يفعل', zh: '做', ja: 'する', pt: 'fazer', it: 'fare', ru: 'делать' },
  does: { es: 'hace', fr: 'fait', de: 'tut', yo: 'ṣe', ha: 'yake yi', ig: 'na-eme', ar: 'يفعل', zh: '做', ja: 'する', pt: 'faz', it: 'fa', ru: 'делает' },
  did: { es: 'hizo', fr: 'a fait', de: 'tat', yo: 'ti ṣe', ha: 'ya yi', ig: 'mere', ar: 'فعل', zh: '做了', ja: 'した', pt: 'fez', it: 'ha fatto', ru: 'сделал' },
  can: { es: 'puede', fr: 'peut', de: 'kann', yo: 'le', ha: 'iya', ig: 'nwere ike', ar: 'يمكن', zh: '能', ja: 'できる', pt: 'pode', it: 'può', ru: 'может' },
  will: { es: 'hará', fr: 'fera', de: 'wird', yo: 'yoo', ha: 'zai', ig: 'ga-', ar: 'سوف', zh: '将', ja: 'でしょう', pt: 'irá', it: 'farà', ru: 'будет' },
  go: { es: 'ir', fr: 'aller', de: 'gehen', yo: 'lọ', ha: 'tafi', ig: 'gaa', ar: 'يذهب', zh: '去', ja: '行く', pt: 'ir', it: 'andare', ru: 'идти' },
  come: { es: 'venir', fr: 'venir', de: 'kommen', yo: 'wá', ha: 'zo', ig: 'bịa', ar: 'يأتي', zh: '来', ja: '来る', pt: 'vir', it: 'venire', ru: 'приходить' },
  say: { es: 'decir', fr: 'dire', de: 'sagen', yo: 'sọ', ha: 'faɗi', ig: 'kwuo', ar: 'يقول', zh: '说', ja: '言う', pt: 'dizer', it: 'dire', ru: 'сказать' },
  get: { es: 'obtener', fr: 'obtenir', de: 'bekommen', yo: 'gba', ha: 'samu', ig: 'nweta', ar: 'يحصل', zh: '得到', ja: '得る', pt: 'obter', it: 'ottenere', ru: 'получать' },
  make: { es: 'hacer', fr: 'créer', de: 'machen', yo: 'ṣe', ha: 'yi', ig: 'mepụta', ar: 'يصنع', zh: '制作', ja: '作る', pt: 'fazer', it: 'fare', ru: 'делать' },
  know: { es: 'saber', fr: 'savoir', de: 'wissen', yo: 'mọ', ha: 'sani', ig: 'mara', ar: 'يعرف', zh: '知道', ja: '知る', pt: 'saber', it: 'sapere', ru: 'знать' },
  think: { es: 'pensar', fr: 'penser', de: 'denken', yo: 'ro', ha: 'tunanin', ig: 'chee', ar: 'يفكر', zh: '想', ja: '思う', pt: 'pensar', it: 'pensare', ru: 'думать' },
  take: { es: 'tomar', fr: 'prendre', de: 'nehmen', yo: 'mu', ha: 'ɗauka', ig: 'were', ar: 'يأخذ', zh: '拿', ja: '取る', pt: 'tomar', it: 'prendere', ru: 'брать' },
  see: { es: 'ver', fr: 'voir', de: 'sehen', yo: 'ri', ha: 'gani', ig: 'hụ', ar: 'يرى', zh: '看见', ja: '見る', pt: 'ver', it: 'vedere', ru: 'видеть' },
  want: { es: 'querer', fr: 'vouloir', de: 'wollen', yo: 'fẹ', ha: 'so', ig: 'chọrọ', ar: 'يريد', zh: '想要', ja: '欲しい', pt: 'querer', it: 'volere', ru: 'хотеть' },
  look: { es: 'mirar', fr: 'regarder', de: 'schauen', yo: 'wo', ha: 'duba', ig: 'lee', ar: 'ينظر', zh: '看', ja: '見る', pt: 'olhar', it: 'guardare', ru: 'смотреть' },
  use: { es: 'usar', fr: 'utiliser', de: 'verwenden', yo: 'lo', ha: 'amfani', ig: 'jiri', ar: 'يستخدم', zh: '使用', ja: '使う', pt: 'usar', it: 'usare', ru: 'использовать' },
  find: { es: 'encontrar', fr: 'trouver', de: 'finden', yo: 'ri', ha: 'nemo', ig: 'chọta', ar: 'يجد', zh: '找到', ja: '見つける', pt: 'encontrar', it: 'trovare', ru: 'находить' },
  give: { es: 'dar', fr: 'donner', de: 'geben', yo: 'fun', ha: 'ba', ig: 'nye', ar: 'يعطي', zh: '给', ja: '与える', pt: 'dar', it: 'dare', ru: 'давать' },
  tell: { es: 'contar', fr: 'dire', de: 'erzählen', yo: 'sọ fun', ha: 'faɗa', ig: 'gwa', ar: 'يخبر', zh: '告诉', ja: '伝える', pt: 'contar', it: 'raccontare', ru: 'рассказывать' },
  work: { es: 'trabajar', fr: 'travailler', de: 'arbeiten', yo: 'ṣiṣẹ', ha: 'aiki', ig: 'rụọ ọrụ', ar: 'يعمل', zh: '工作', ja: '働く', pt: 'trabalhar', it: 'lavorare', ru: 'работать' },
  call: { es: 'llamar', fr: 'appeler', de: 'anrufen', yo: 'pe', ha: 'kira', ig: 'kpọọ', ar: 'يتصل', zh: '呼叫', ja: '呼ぶ', pt: 'chamar', it: 'chiamare', ru: 'звонить' },
  try: { es: 'intentar', fr: 'essayer', de: 'versuchen', yo: 'gbiyanju', ha: 'gwada', ig: 'nwaa', ar: 'يحاول', zh: '尝试', ja: '試す', pt: 'tentar', it: 'provare', ru: 'пытаться' },
  ask: { es: 'preguntar', fr: 'demander', de: 'fragen', yo: 'beere', ha: 'tambaya', ig: 'jụọ', ar: 'يسأل', zh: '问', ja: '尋ねる', pt: 'perguntar', it: 'chiedere', ru: 'спрашивать' },
  need: { es: 'necesitar', fr: 'avoir besoin', de: 'brauchen', yo: 'nilo', ha: 'bukata', ig: 'mkpa', ar: 'يحتاج', zh: '需要', ja: '必要', pt: 'precisar', it: 'avere bisogno', ru: 'нуждаться' },
  feel: { es: 'sentir', fr: 'sentir', de: 'fühlen', yo: 'lero', ha: 'ji', ig: 'chee', ar: 'يشعر', zh: '感觉', ja: '感じる', pt: 'sentir', it: 'sentire', ru: 'чувствовать' },
  listen: { es: 'escuchar', fr: 'écouter', de: 'zuhören', yo: 'tẹtisi', ha: 'saurara', ig: 'gee ntị', ar: 'استمع', zh: '听', ja: '聞く', pt: 'ouvir', it: 'ascoltare', ru: 'слушать' },
  speak: { es: 'hablar', fr: 'parler', de: 'sprechen', yo: 'sọrọ', ha: 'yi magana', ig: 'kwuo okwu', ar: 'تكلم', zh: '说话', ja: '話す', pt: 'falar', it: 'parlare', ru: 'говорить' },
  hear: { es: 'oír', fr: 'entendre', de: 'hören', yo: 'gbọ', ha: 'ji', ig: 'nụ', ar: 'يسمع', zh: '听见', ja: '聞こえる', pt: 'ouvir', it: 'udire', ru: 'слышать' },
  play: { es: 'reproducir', fr: 'lire', de: 'abspielen', yo: 'ṣere', ha: 'kunna', ig: 'kpọọ', ar: 'تشغيل', zh: '播放', ja: '再生', pt: 'reproduzir', it: 'riprodurre', ru: 'воспроизвести' },
  stop: { es: 'detener', fr: 'arrêter', de: 'stoppen', yo: 'duro', ha: 'tsaya', ig: 'kwụsị', ar: 'توقف', zh: '停止', ja: '停止', pt: 'parar', it: 'fermare', ru: 'остановить' },
  start: { es: 'iniciar', fr: 'démarrer', de: 'starten', yo: 'bẹrẹ', ha: 'fara', ig: 'bido', ar: 'بدء', zh: '开始', ja: '開始', pt: 'iniciar', it: 'iniziare', ru: 'начать' },
  record: { es: 'grabar', fr: 'enregistrer', de: 'aufnehmen', yo: 'gbohùn', ha: 'rikodi', ig: 'dekọọ', ar: 'تسجيل', zh: '录音', ja: '録音', pt: 'gravar', it: 'registrare', ru: 'записать' },

  // Media, Conversion & Tech Vocabulary
  convert: { es: 'convertir', fr: 'convertir', de: 'konvertieren', yo: 'yi pada', ha: 'canza', ig: 'tụgharịa', ar: 'تحويل', zh: '转换', ja: '変換', pt: 'converter', it: 'convertire', ru: 'конвертировать' },
  converter: { es: 'convertidor', fr: 'convertisseur', de: 'konverter', yo: 'oluyipada', ha: 'mai canzawa', ig: 'onye ntụgharị', ar: 'محول', zh: '转换器', ja: 'コンバータ', pt: 'conversor', it: 'convertitore', ru: 'конвертер' },
  conversion: { es: 'conversión', fr: 'conversion', de: 'konvertierung', yo: 'iyipada', ha: 'sauyi', ig: 'ntụgharị', ar: 'تحويل', zh: '转换', ja: '変換', pt: 'conversão', it: 'conversione', ru: 'конверсия' },
  video: { es: 'video', fr: 'vidéo', de: 'video', yo: 'fidio', ha: 'bidiyo', ig: 'vidiyo', ar: 'فيديو', zh: '视频', ja: 'ビデオ', pt: 'vídeo', it: 'video', ru: 'видео' },
  audio: { es: 'audio', fr: 'audio', de: 'audio', yo: 'orin/ohun', ha: 'sauti', ig: 'ụda', ar: 'صوت', zh: '音频', ja: 'オーディオ', pt: 'áudio', it: 'audio', ru: 'аудио' },
  sound: { es: 'sonido', fr: 'son', de: 'klang', yo: 'ohun', ha: 'sauti', ig: 'ụda', ar: 'صوت', zh: '声音', ja: '音', pt: 'som', it: 'suono', ru: 'звук' },
  track: { es: 'pista', fr: 'piste', de: 'spur', yo: 'orin', ha: 'hanya', ig: 'ụzọ', ar: 'مسار', zh: '音轨', ja: 'トラック', pt: 'faixa', it: 'traccia', ru: 'дорожка' },
  stream: { es: 'transmisión', fr: 'flux', de: 'strom', yo: 'ṣiṣan', ha: 'rafi', ig: 'iyi', ar: 'تدفق', zh: '流', ja: 'ストリーム', pt: 'fluxo', it: 'flusso', ru: 'поток' },
  media: { es: 'medios', fr: 'médias', de: 'medien', yo: 'amohunmaworan', ha: 'kafofin watsa labarai', ig: 'mgbasa ozi', ar: 'وسائط', zh: '媒体', ja: 'メディア', pt: 'mídia', it: 'media', ru: 'медиа' },
  file: { es: 'archivo', fr: 'fichier', de: 'datei', yo: 'faili', ha: 'fayil', ig: 'faịlụ', ar: 'ملف', zh: '文件', ja: 'ファイル', pt: 'arquivo', it: 'file', ru: 'файл' },
  speech: { es: 'habla', fr: 'parole', de: 'sprache', yo: 'ọrọ', ha: 'magana', ig: 'okwu', ar: 'كلام', zh: '语音', ja: '音声', pt: 'fala', it: 'parola', ru: 'речь' },
  text: { es: 'texto', fr: 'texte', de: 'text', yo: 'ọrọ kiko', ha: 'rubutu', ig: 'ederede', ar: 'نص', zh: '文本', ja: 'テキスト', pt: 'texto', it: 'testo', ru: 'текст' },
  word: { es: 'palabra', fr: 'mot', de: 'wort', yo: 'ọrọ', ha: 'kalma', ig: 'okwu', ar: 'كلمة', zh: '词', ja: '単語', pt: 'palavra', it: 'parola', ru: 'слово' },
  sentence: { es: 'frase', fr: 'phrase', de: 'satz', yo: 'gbolohun', ha: 'jimla', ig: 'ahịrịokwu', ar: 'جملة', zh: '句子', ja: '文', pt: 'frase', it: 'frase', ru: 'предложение' },
  translation: { es: 'traducción', fr: 'traduction', de: 'übersetzung', yo: 'itumo', ha: 'fassara', ig: 'ntụgharị', ar: 'ترجمة', zh: '翻译', ja: '翻訳', pt: 'tradução', it: 'traduzione', ru: 'перевод' },
  translate: { es: 'traducir', fr: 'traduire', de: 'übersetzen', yo: 'tumọ', ha: 'fassara', ig: 'tụgharịa', ar: 'ترجم', zh: '翻译', ja: '翻訳する', pt: 'traduzir', it: 'tradurre', ru: 'переводить' },
  subtitle: { es: 'subtítulo', fr: 'sous-titre', de: 'untertitel', yo: 'akole isale', ha: 'fassarar ƙasa', ig: 'nkọwa okwu', ar: 'ترجمة نصية', zh: '字幕', ja: '字幕', pt: 'legenda', it: 'sottotitolo', ru: 'субтитр' },
  subtitles: { es: 'subtítulos', fr: 'sous-titres', de: 'untertitel', yo: 'akole isale', ha: 'fassarar ƙasa', ig: 'nkọwa okwu', ar: 'ترجمات', zh: '字幕', ja: '字幕', pt: 'legendas', it: 'sottotitoli', ru: 'субтитры' },
  download: { es: 'descargar', fr: 'télécharger', de: 'herunterladen', yo: 'gbasilẹ', ha: 'saukar', ig: 'budata', ar: 'تنزيل', zh: '下载', ja: 'ダウンロード', pt: 'baixar', it: 'scaricare', ru: 'скачать' },
  save: { es: 'guardar', fr: 'enregistrer', de: 'speichern', yo: 'fipamọ', ha: 'ajiye', ig: 'chekwaa', ar: 'حفظ', zh: '保存', ja: '保存', pt: 'salvar', it: 'salva', ru: 'сохранить' },
  fast: { es: 'rápido', fr: 'rapide', de: 'schnell', yo: 'yara', ha: 'sauri', ig: 'ngwa ngwa', ar: 'سريع', zh: '快', ja: '速い', pt: 'rápido', it: 'veloce', ru: 'быстро' },
  slow: { es: 'lento', fr: 'lent', de: 'langsam', yo: 'lọra', ha: 'a hankali', ig: 'nwayọọ', ar: 'بطيء', zh: '慢', ja: '遅い', pt: 'lento', it: 'lento', ru: 'медленно' },
  high: { es: 'alto', fr: 'haut', de: 'hoch', yo: 'giga', ha: 'tsawo', ig: 'elu', ar: 'عالي', zh: '高', ja: '高い', pt: 'alto', it: 'alto', ru: 'высокий' },
  quality: { es: 'calidad', fr: 'qualité', de: 'qualität', yo: 'didara', ha: 'inganci', ig: 'mma', ar: 'جودة', zh: '质量', ja: '品質', pt: 'qualidade', it: 'qualità', ru: 'качество' },
  speed: { es: 'velocidad', fr: 'vitesse', de: 'geschwindigkeit', yo: 'ere', ha: 'gudu', ig: 'ọsọ', ar: 'سرعة', zh: '速度', ja: '速度', pt: 'velocidade', it: 'velocità', ru: 'скорость' },
  universal: { es: 'universal', fr: 'universel', de: 'universell', yo: 'agbaye', ha: 'duniya', ig: 'uwa dum', ar: 'شامل', zh: '通用', ja: 'ユニバーサル', pt: 'universal', it: 'universale', ru: 'универсальный' },
  platform: { es: 'plataforma', fr: 'plateforme', de: 'plattform', yo: 'pẹpẹ', ha: 'dandamali', ig: 'ikpo okwu', ar: 'منصة', zh: '平台', ja: 'プラットフォーム', pt: 'plataforma', it: 'piattaforma', ru: 'платформа' },
  system: { es: 'sistema', fr: 'système', de: 'system', yo: 'eto', ha: 'tsarin', ig: 'usoro', ar: 'نظام', zh: '系统', ja: 'システム', pt: 'sistema', it: 'sistema', ru: 'система' },
  windows: { es: 'windows', fr: 'windows', de: 'windows', yo: 'windows', ha: 'windows', ig: 'windows', ar: 'ويندوز', zh: '视窗', ja: 'ウィンドウズ', pt: 'windows', it: 'windows', ru: 'виндовс' },
  android: { es: 'android', fr: 'android', de: 'android', yo: 'android', ha: 'android', ig: 'android', ar: 'أندرويد', zh: '安卓', ja: 'アンドロイド', pt: 'android', it: 'android', ru: 'андроид' },
  iphone: { es: 'iphone', fr: 'iphone', de: 'iphone', yo: 'iphone', ha: 'iphone', ig: 'iphone', ar: 'آيفون', zh: '苹果手机', ja: 'アイフォン', pt: 'iphone', it: 'iphone', ru: 'айфон' },
  time: { es: 'tiempo', fr: 'temps', de: 'zeit', yo: 'akoko', ha: 'lokaci', ig: 'oge', ar: 'وقت', zh: '时间', ja: '時間', pt: 'tempo', it: 'tempo', ru: 'время' },
  now: { es: 'ahora', fr: 'maintenant', de: 'jetzt', yo: 'bayi', ha: 'yanzu', ig: 'ugbua', ar: 'الآن', zh: '现在', ja: '今', pt: 'agora', it: 'ora', ru: 'сейчас' },
  today: { es: 'hoy', fr: 'aujourd\'hui', de: 'heute', yo: 'loni', ha: 'yau', ig: 'taa', ar: 'اليوم', zh: '今天', ja: '今日', pt: 'hoje', it: 'oggi', ru: 'сегодня' },

  // Numbers
  one: { es: 'uno', fr: 'un', de: 'eins', yo: 'ọkan', ha: 'ɗaya', ig: 'otu', ar: 'واحد', zh: '一', ja: '一', pt: 'um', it: 'uno', ru: 'один' },
  two: { es: 'dos', fr: 'deux', de: 'zwei', yo: 'eji', ha: 'biyu', ig: 'abụọ', ar: 'اثنان', zh: '二', ja: '二', pt: 'dois', it: 'due', ru: 'два' },
  three: { es: 'tres', fr: 'trois', de: 'drei', yo: 'ẹta', ha: 'uku', ig: 'atọ', ar: 'ثلاثة', zh: '三', ja: '三', pt: 'três', it: 'tre', ru: 'три' },
  four: { es: 'cuatro', fr: 'quatre', de: 'vier', yo: 'ẹrin', ha: 'huɗu', ig: 'anọ', ar: 'أربعة', zh: '四', ja: '四', pt: 'quatro', it: 'quattro', ru: 'четыре' },
  five: { es: 'cinco', fr: 'cinq', de: 'fünf', yo: 'aarun', ha: 'biyar', ig: 'ise', ar: 'خمسة', zh: '五', ja: '五', pt: 'cinco', it: 'cinque', ru: 'пять' },
  six: { es: 'seis', fr: 'six', de: 'sechs', yo: 'ẹfa', ha: 'shida', ig: 'isii', ar: 'ستة', zh: '六', ja: '六', pt: 'seis', it: 'sei', ru: 'шесть' },
  seven: { es: 'siete', fr: 'sept', de: 'sieben', yo: 'eeje', ha: 'bakwai', ig: 'asaa', ar: 'سبعة', zh: '七', ja: '七', pt: 'sete', it: 'sette', ru: 'семь' },
  eight: { es: 'ocho', fr: 'huit', de: 'acht', yo: 'ẹjọ', ha: 'takwas', ig: 'asatọ', ar: 'ثمانية', zh: '八', ja: '八', pt: 'oito', it: 'otto', ru: 'восемь' },
  nine: { es: 'nueve', fr: 'neuf', de: 'neun', yo: 'ẹsan', ha: 'tara', ig: 'itoolu', ar: 'تسعة', zh: '九', ja: '九', pt: 'nove', it: 'nove', ru: 'девять' },
  ten: { es: 'diez', fr: 'dix', de: 'zehn', yo: 'ẹwa', ha: 'goma', ig: 'iri', ar: 'عشرة', zh: '十', ja: '十', pt: 'dez', it: 'dieci', ru: 'десять' }
};

class SpeechEngine {
  constructor() {
    const Ctor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    this.Recognition = Ctor || null;
    this.activeRecognition = null;
    this.isDictating = false;
    this.lexicon = LEXICON;
    this.apiCache = new Map();
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this._workerWarmedModel = null;
    this._workerWarmupPromise = null;
  }

  isSupported() {
    return Boolean(this.Recognition);
  }

  splitWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
  }

  cleanWord(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Translate a single word word-for-word using offline lexicon
   */
  translateWord(word, srcLang = 'en', targetLang = 'es') {
    const clean = this.cleanWord(word);
    const targetKey = (targetLang || 'es').split('-')[0].toLowerCase();
    const srcKey = (srcLang || 'en').split('-')[0].toLowerCase();

    if (srcKey === targetKey) return word;

    // Direct English -> Target
    if (this.lexicon[clean] && this.lexicon[clean][targetKey]) {
      return this.lexicon[clean][targetKey];
    }

    // Reverse lookup (Source Language -> English -> Target)
    for (const [enWord, translations] of Object.entries(this.lexicon)) {
      if (translations[srcKey] && translations[srcKey].toLowerCase() === clean) {
        if (targetKey === 'en') return enWord;
        if (translations[targetKey]) return translations[targetKey];
      }
    }

    // Default fallback: return original word
    return word;
  }

  /**
   * Translate full text sentence and word-for-word
   */
  translateText(text, srcLang = 'en', targetLang = 'es') {
    const words = this.splitWords(text);
    const translatedWords = words.map(w => this.translateWord(w, srcLang, targetLang));
    return translatedWords.join(' ');
  }

  /**
   * Hybrid translation: tries free public API if online, falls back instantly to offline lexicon
   */
  async translateTextAsync(text, srcLang = 'en', targetLang = 'es') {
    const cleanText = String(text || '').trim();
    if (!cleanText) return '';

    const srcCode = (srcLang || 'en').split('-')[0].toLowerCase();
    const targetCode = (targetLang || 'es').split('-')[0].toLowerCase();

    if (srcCode === targetCode) return cleanText;

    const cacheKey = `${srcCode}:${targetCode}:${cleanText}`;
    if (this.apiCache.has(cacheKey)) {
      return this.apiCache.get(cacheKey);
    }

    // Try online translation with tight 1500ms timeout
    if (typeof fetch === 'function' && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanText)}&langpair=${srcCode}|${targetCode}`;
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.responseData && data.responseData.translatedText) {
            const result = data.responseData.translatedText;
            this.apiCache.set(cacheKey, result);
            return result;
          }
        }
      } catch (e) {
        // Fall back gracefully to offline lexicon
      }
    }

    // Instant offline fallback
    const offlineResult = this.translateText(cleanText, srcLang, targetLang);
    this.apiCache.set(cacheKey, offlineResult);
    return offlineResult;
  }

  /**
   * Text-to-Speech (Pronounce text with native voice & accent)
   */
  speakText(text, lang = 'en-US', rate = 1.0) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = Math.max(0.5, Math.min(2, rate));

      // Pick matching voice if available
      const voices = window.speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        const langCode = lang.split('-')[0].toLowerCase();
        const matched = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langCode));
        if (matched) utterance.voice = matched;
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('Speech synthesis playback error:', e);
    }
  }

  /**
   * Extract mono 16kHz WAV from any video or audio file for speech processing
   */
  async extractSpeechAudio(file, progressCallback = () => {}) {
    if (window.ffmpegBridge && window.ffmpegBridge.ensureLoaded) {
      try {
        return await window.ffmpegBridge.extractAudio(file, 'wav', { channels: 'mono', sampleRate: 16000 }, progressCallback);
      } catch (e) {
        console.warn('FFmpeg speech audio extraction fallback to audio context:', e);
      }
    }

    if (window.audioEngine) {
      const audioBuffer = await window.audioEngine.decodeAudio(file, progressCallback);
      const monoBuffer = window.audioEngine.downmixToMono(audioBuffer);
      return await window.audioEngine.audioBufferToWavAsync(monoBuffer, progressCallback);
    }

    return file;
  }

  /**
   * Word-for-word live microphone dictation with streaming translation
   */
  async startLiveDictation({ srcLang = 'en-US', targetLang = 'es-ES', model, onWord, onFinal, onError, onStatusChange }) {
    this.isDictating = true;

    // Prefer in-browser Whisper LiveDictation engine with 16kHz resampling & VAD chunking
    const LiveDictationClass = (typeof window !== 'undefined' && window.LiveDictation) ? window.LiveDictation : null;
    if (LiveDictationClass) {
      if (this.liveDictation) {
        try { this.liveDictation.stop(); } catch (e) {}
      }

      this.liveDictation = new LiveDictationClass({
        srcLang,
        targetLang,
        model: model || (srcLang.startsWith('en') ? 'Xenova/whisper-base.en' : 'Xenova/whisper-base'),
        onWord: (pairs, fullText, translatedFull) => {
          if (onWord) onWord(pairs, fullText, translatedFull);
          if (onFinal) onFinal(fullText, translatedFull);
        },
        onStatusChange: (status) => {
          if (onStatusChange) onStatusChange(status);
        },
        onError: (err) => {
          console.warn('[LiveDictation] error:', err);
          if (onError) onError(err);
        }
      });

      try {
        await this.liveDictation.start();
        return this.liveDictation;
      } catch (err) {
        console.warn('[LiveDictation] Failed to start LiveDictation, falling back to Web Speech API:', err);
      }
    }

    // Fallback: Web Speech API (Chrome/Edge SpeechRecognition)
    if (!this.Recognition) {
      throw new Error('Microphone speech recognition is not supported in this browser.');
    }

    if (this.activeRecognition) {
      try { this.activeRecognition.stop(); } catch (e) {}
    }

    const rec = new this.Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = srcLang;
    rec.maxAlternatives = 1;

    let committedText = '';
    this.activeRecognition = rec;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i][0];
        if (event.results[i].isFinal) {
          committedText += (committedText ? ' ' : '') + item.transcript.trim();
        } else {
          interim += ' ' + item.transcript;
        }
      }

      const fullText = (committedText + interim).replace(/\s+/g, ' ').trim();
      const rawWords = this.splitWords(fullText);

      // Compute word-for-word translation for each word
      const wordPairs = rawWords.map((w, idx) => ({
        index: idx + 1,
        word: w,
        translation: this.translateWord(w, srcLang, targetLang)
      }));

      const translatedFull = wordPairs.map(wp => wp.translation).join(' ');

      if (onWord) onWord(wordPairs, fullText, translatedFull, interim.trim());
      if (onFinal && committedText) onFinal(committedText, this.translateText(committedText, srcLang, targetLang));
    };

    rec.onerror = (e) => {
      if (e.error !== 'no-speech') {
        console.warn('Live speech recognition error:', e.error);
        if (onError) onError(e.error);
      }
    };

    rec.onend = () => {
      this.isDictating = false;
    };

    rec.start();
    return rec;
  }

  stopLiveDictation() {
    if (this.liveDictation) {
      try { this.liveDictation.stop(); } catch (e) {}
      this.liveDictation = null;
    }
    if (this.activeRecognition) {
      try { this.activeRecognition.stop(); } catch (e) {}
      this.activeRecognition = null;
    }
    this.isDictating = false;
  }

  /**
   * Initialize or retrieve the background Web Worker for Whisper AI
   */
  initWhisperWorker() {
    if (this.whisperWorker) return this.whisperWorker;
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;

    // Resolve the worker relative to the page (index.html lives next to
    // whisper-worker.js). An absolute "/whisper-worker.js" breaks under
    // Electron's file:// fallback, and `new Worker()` never throws on a 404,
    // so a list of "fallback" paths could not work anyway.
    let workerUrl;
    try {
      workerUrl = new URL('whisper-worker.js', document.baseURI).href;
    } catch (e) {
      workerUrl = 'whisper-worker.js';
    }

    {
      const workerPath = workerUrl;
      try {
        const worker = new Worker(workerPath, { type: 'module' });
        this.whisperWorker = worker;
        this.whisperWorker.addEventListener('error', (err) => {
          console.warn(`Whisper worker runtime error with "${workerPath}":`, err);
        });
        this.whisperWorker.addEventListener('message', (event) => {
          const data = event.data || {};
          const { id, type, status } = data;

          // Dispatch model loading progress to UI if requested
          if (type === 'model-load-progress' || status === 'loading' || status === 'progress') {
            if (typeof document !== 'undefined') {
              document.dispatchEvent(new CustomEvent('whisper-load-progress', { detail: data }));
            }
          }

          // Route correlation ID to awaiting Promise
          if (id && this.pendingRequests.has(id)) {
            const req = this.pendingRequests.get(id);
            if (type === 'warmup-complete' || status === 'model_ready') {
              this.pendingRequests.delete(id);
              req.resolve(data);
            } else if (type === 'transcribe-result' || status === 'complete') {
              this.pendingRequests.delete(id);
              req.resolve(data.result || data);
            } else if (type === 'error' || status === 'error') {
              this.pendingRequests.delete(id);
              req.reject(new Error(data.message || data.error || 'Whisper transcription failed'));
            }
          }
        });
        return this.whisperWorker;
      } catch (e) {
        console.warn(`Failed to initialize worker with path "${workerPath}":`, e);
      }
    }
    return null;
  }

  /**
   * Convert an audio Blob/File into a 16kHz Float32Array on main thread
   */
  async decodeAudioForWhisper(audioBlob) {
    const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AudioCtx) {
      throw new Error('Web AudioContext is not supported in this environment');
    }

    // 1. Create an AudioContext locked to 16000 Hz (Whisper's required sample rate)
    const audioContext = new AudioCtx({ sampleRate: 16000 });

    try {
      // 2. Read the Blob as an ArrayBuffer (or use in-memory buffer if present)
      const arrayBuffer = (audioBlob && audioBlob.buffer) ? audioBlob.buffer : await audioBlob.arrayBuffer();

      // 3. Decode the audio file into raw PCM data
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // 4. Extract the first channel (Mono) as a Float32Array
      const float32Data = audioBuffer.getChannelData(0);

      // Create clean detached copy
      return new Float32Array(float32Data);
    } finally {
      if (audioContext && audioContext.close) {
        try { audioContext.close(); } catch (e) {}
      }
    }
  }

  /**
   * Run speech-to-text on the background Web Worker with decoded 16kHz Float32Array.
   * @param {Blob|File|Float32Array} audioBlob - media to decode, or already-decoded 16 kHz mono PCM
   */
  async transcribeWithWhisper(audioBlob, options = {}) {
    const worker = this.initWhisperWorker();
    if (!worker) {
      throw new Error('Web Workers not available in this environment');
    }

    const { srcLang, onProgress } = options;

    // Callers that already decoded 16 kHz mono PCM (e.g. subtitles.js) pass a
    // Float32Array directly so the media is only decoded once.
    let rawAudioData;
    if (audioBlob instanceof Float32Array) {
      rawAudioData = audioBlob;
    } else {
      if (onProgress) onProgress({ percent: 35, stage: 'Decoding audio into 16kHz Float32 PCM...' });
      rawAudioData = await this.decodeAudioForWhisper(audioBlob);
    }

    const isEnglish = !srcLang || srcLang.startsWith('en');
    // Default to Xenova/whisper-base (~73MB) for high accent resilience and music filtering
    const selectedModel = options.model || (isEnglish ? 'Xenova/whisper-base.en' : 'Xenova/whisper-base');

    return new Promise((resolve, reject) => {
      const messageHandler = (event) => {
        const data = event.data || {};
        if (data.status === 'progress') {
          if (onProgress && data.progress) {
            const p = data.progress;
            const pct = p.progress ? Math.round(p.progress * 100) : (p.loaded && p.total ? Math.round((p.loaded / p.total) * 100) : 50);
            onProgress({ percent: Math.max(20, Math.min(85, pct)), stage: `Downloading AI model (${p.file || selectedModel})... ${pct}%` });
          }
        } else if (data.status === 'loading') {
          if (onProgress) onProgress({ percent: 45, stage: data.message });
        } else if (data.status === 'transcribing') {
          if (onProgress) onProgress({ percent: 70, stage: data.message });
        } else if (data.status === 'complete') {
          // 1. Get the word-for-word array
          const wordLevelData = (data.result && data.result.chunks) ? data.result.chunks : [];

          // 2. Log it to prove it's broken down word-for-word
          console.log("Word Chunks:", wordLevelData);

          worker.removeEventListener('message', messageHandler);
          worker.removeEventListener('error', errorHandler);
          resolve(data.result);
        } else if (data.status === 'error') {
          worker.removeEventListener('message', messageHandler);
          worker.removeEventListener('error', errorHandler);
          reject(new Error(data.message || 'Whisper transcription failed'));
        }
      };

      const errorHandler = (err) => {
        worker.removeEventListener('message', messageHandler);
        worker.removeEventListener('error', errorHandler);
        reject(err);
      };

      worker.addEventListener('message', messageHandler);
      worker.addEventListener('error', errorHandler);

      worker.postMessage({
        action: 'transcribe',
        audioData: rawAudioData,
        selectedModel,
        language: srcLang,
        isEnglish
      });
    });
  }

  /**
   * Pre-load / warm up Whisper AI model singleton before live chunks arrive
   */
  async warmupWhisperWorker(options = {}) {
    const worker = this.initWhisperWorker();
    if (!worker) return;

    const { srcLang } = options;
    const isEnglish = !srcLang || srcLang.startsWith('en');
    const selectedModel = options.model || (isEnglish ? 'Xenova/whisper-base.en' : 'Xenova/whisper-base');

    if (this._workerWarmedModel === selectedModel && this._workerWarmupPromise) {
      return this._workerWarmupPromise;
    }

    this._workerWarmedModel = selectedModel;
    const id = this.nextRequestId++;

    this._workerWarmupPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn('[SpeechEngine] Warmup timeout elapsed, continuing...');
        this.pendingRequests.delete(id);
        resolve();
      }, 45000);

      this.pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      worker.postMessage({
        action: 'warmup',
        type: 'warmup',
        id,
        selectedModel,
        language: srcLang,
        isEnglish
      });
    });

    return this._workerWarmupPromise;
  }

  /**
   * Directly transcribe raw Float32Array PCM (16kHz) via background Whisper worker
   */
  async transcribeFloat32Array(rawAudioData, options = {}) {
    const worker = this.initWhisperWorker();
    if (!worker) {
      throw new Error('Web Workers not available in this environment');
    }

    if (!rawAudioData || !(rawAudioData instanceof Float32Array)) {
      throw new Error('Expected rawAudioData to be a Float32Array');
    }

    // Ensure model is warmed up first
    await this.warmupWhisperWorker(options);

    const { srcLang } = options;
    const isEnglish = !srcLang || srcLang.startsWith('en');
    const selectedModel = options.model || (isEnglish ? 'Xenova/whisper-base.en' : 'Xenova/whisper-base');
    const id = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      const timeoutMs = 25000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Whisper inference timed out'));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      // Transfer buffer for speed and zero-copy efficiency
      worker.postMessage({
        action: 'transcribe',
        type: 'transcribe-chunk',
        id,
        audioData: rawAudioData,
        selectedModel,
        language: srcLang,
        isEnglish
      }, [rawAudioData.buffer]);
    });
  }

  /**
   * Transcribe a media file word-for-word with timecode tracking & word-to-word translation
   * Uses background Web Worker (whisper-tiny.en / whisper-tiny) without blocking UI thread.
   */
  async transcribeMediaFile(file, options = {}) {
    const srcLang = options.srcLang || options.lang || 'en-US';
    const targetLang = options.targetLang || 'es-ES';
    const onProgress = options.onProgress || (() => {});
    const onWordStream = options.onWordStream || (() => {});

    onProgress({ percent: 10, stage: 'Extracting 16kHz speech audio stream...' });
    const wavBlob = await this.extractSpeechAudio(file, (p) => {
      const pct = typeof p === 'object' ? (p.percent || 10) : Number(p);
      onProgress({ percent: Math.round(10 + pct * 0.35), stage: 'Demuxing audio track...' });
    });

    let timedWords = [];
    let fullText = '';
    let duration = 0;

    // First attempt: Background Web Worker running 40MB quantized whisper-tiny model
    let usedWhisper = false;
    try {
      onProgress({ percent: 45, stage: 'Connecting to background Whisper AI worker...' });
      const whisperResult = await this.transcribeWithWhisper(wavBlob, {
        srcLang,
        model: options.model,
        onProgress
      });

      if (whisperResult && (whisperResult.chunks || whisperResult.text)) {
        usedWhisper = true;
        fullText = (whisperResult.text || (whisperResult.chunks ? whisperResult.chunks.map(c => c.text).join(' ') : '')).trim();
        
        // 1. Get the word-for-word array
        const wordLevelData = Array.isArray(whisperResult.chunks) ? whisperResult.chunks : [];
        // 2. Log it to prove it's broken down word-for-word
        console.log("Processing Word Chunks:", wordLevelData);

        const wordList = [];
        let wordIdx = 1;

        if (wordLevelData.length > 0) {
          wordLevelData.forEach((chunk) => {
            const chunkText = String(chunk.text || '').trim();
            if (!chunkText) return;

            const start = (chunk.timestamp && chunk.timestamp[0] != null) ? Number(chunk.timestamp[0]) : ((wordIdx - 1) * 0.35);
            const end = (chunk.timestamp && chunk.timestamp[1] != null) ? Number(chunk.timestamp[1]) : (start + 0.35);
            duration = Math.max(duration, end);

            // Split into individual words to guarantee word-level chips even if chunk contains whitespace
            const splitWords = chunkText.split(/\s+/).filter(Boolean);
            if (splitWords.length <= 1) {
              const singleWord = splitWords[0] || chunkText;
              wordList.push({
                word: singleWord,
                translation: this.translateWord(singleWord, srcLang, targetLang),
                index: wordIdx++,
                startSec: parseFloat(start.toFixed(3)),
                endSec: parseFloat(end.toFixed(3)),
                startTime: this.formatTimecode(start),
                endTime: this.formatTimecode(end)
              });
            } else {
              // Interpolate timestamps across words in this chunk
              const chunkDuration = Math.max(0.05, end - start);
              const step = chunkDuration / splitWords.length;
              splitWords.forEach((w, wSubIdx) => {
                const wStart = start + (wSubIdx * step);
                const wEnd = (wSubIdx === splitWords.length - 1) ? end : (wStart + step);
                wordList.push({
                  word: w,
                  translation: this.translateWord(w, srcLang, targetLang),
                  index: wordIdx++,
                  startSec: parseFloat(wStart.toFixed(3)),
                  endSec: parseFloat(wEnd.toFixed(3)),
                  startTime: this.formatTimecode(wStart),
                  endTime: this.formatTimecode(wEnd)
                });
              });
            }
          });
        }

        if (wordList.length === 0 && fullText) {
          const estDuration = Math.max(duration, fullText.split(/\s+/).length * 0.4);
          timedWords = this.generateTimedWords(fullText, estDuration, srcLang, targetLang);
        } else {
          timedWords = wordList;
        }
      }
    } catch (whisperErr) {
      console.warn('Whisper background worker fallback:', whisperErr.message || whisperErr);
    }

    // Fallback: Real-time recognition engine if worker is unavailable or model download failed
    if (!usedWhisper) {
      onProgress({ percent: 55, stage: 'Transcribing speech & analyzing word frequencies...' });
      const result = await this.recognizeAudioBlob(wavBlob, srcLang, (words, full, interim) => {
        const pairs = words.map((w, idx) => ({
          index: idx + 1,
          word: w,
          translation: this.translateWord(w, srcLang, targetLang)
        }));
        const transFull = pairs.map(p => p.translation).join(' ');
        onWordStream(pairs, full, transFull, interim);
      });

      fullText = result.text;
      duration = result.duration || 10;
      timedWords = this.generateTimedWords(fullText, duration, srcLang, targetLang);
    }

    onProgress({ percent: 90, stage: 'Aligning word-for-word timecodes & translations...' });
    const translatedFull = timedWords.map(tw => tw.translation).join(' ');

    onProgress({ percent: 100, stage: 'Transcription & translation complete.' });

    return {
      text: fullText,
      translatedText: translatedFull,
      words: timedWords,
      wordCount: timedWords.length,
      duration: duration || 0,
      audioBlob: wavBlob,
      srcLang,
      targetLang,
      srt: this.generateSRT(timedWords),
      bilingualSrt: this.generateBilingualSRT(timedWords),
      vtt: this.generateVTT(timedWords),
      bilingualVtt: this.generateBilingualVTT(timedWords)
    };
  }

  /**
   * Stream audio into recognition engine while synchronizing timestamps
   */
  recognizeAudioBlob(blob, srcLang = 'en-US', onStream) {
    return new Promise((resolve, reject) => {
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.preload = 'auto';

      if (!this.Recognition) {
        URL.revokeObjectURL(audioUrl);
        reject(new Error('Speech recognition is unavailable: the Whisper model could not be loaded. Check your internet connection (the model is downloaded once) and try again.'));
        return;
      }

      const rec = new this.Recognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = srcLang;

      let committed = '';
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        try { rec.stop(); } catch (e) {}
        audio.pause();
        const dur = audio.duration || 8;
        URL.revokeObjectURL(audioUrl);
        const finalText = committed.replace(/\s+/g, ' ').trim();
        if (!finalText) { reject(new Error('No speech was recognised in this file.')); return; }
        resolve({ text: finalText, duration: dur });
      };

      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i][0];
          if (event.results[i].isFinal) {
            committed += (committed ? ' ' : '') + item.transcript.trim();
          } else {
            interim += ' ' + item.transcript;
          }
        }
        const full = (committed + interim).replace(/\s+/g, ' ').trim();
        if (onStream) onStream(this.splitWords(full), full, interim.trim());
      };

      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        finish();
      };

      rec.onend = () => finish();
      audio.onended = () => setTimeout(finish, 600);
      audio.onerror = () => finish();

      audio.onloadedmetadata = async () => {
        try {
          rec.start();
          await audio.play();
        } catch (err) {
          setTimeout(finish, 1500);
        }
      };

      audio.load();
    });
  }

  /**
   * Generate word-by-word timestamp items with start/end seconds and word-level translations
   */
  generateTimedWords(text, durationSec = 10, srcLang = 'en', targetLang = 'es') {
    const rawWords = this.splitWords(text);
    if (rawWords.length === 0) return [];

    const totalDur = Math.max(2, Number(durationSec) || (rawWords.length * 0.4));
    const wordDur = totalDur / rawWords.length;

    return rawWords.map((word, idx) => {
      const start = idx * wordDur;
      const end = start + wordDur * 0.92;
      return {
        word,
        translation: this.translateWord(word, srcLang, targetLang),
        index: idx + 1,
        startSec: parseFloat(start.toFixed(3)),
        endSec: parseFloat(end.toFixed(3)),
        startTime: this.formatTimecode(start),
        endTime: this.formatTimecode(end)
      };
    });
  }

  formatTimecode(seconds) {
    const secNum = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(secNum / 3600);
    const m = Math.floor((secNum % 3600) / 60);
    const s = Math.floor(secNum % 60);
    const ms = Math.floor((secNum % 1) * 1000);

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  generateSRT(timedWords) {
    if (!timedWords || timedWords.length === 0) return '';
    const chunks = [];
    const wordsPerSubtitle = 6;

    for (let i = 0; i < timedWords.length; i += wordsPerSubtitle) {
      const slice = timedWords.slice(i, i + wordsPerSubtitle);
      const index = Math.floor(i / wordsPerSubtitle) + 1;
      const start = slice[0].startTime;
      const end = slice[slice.length - 1].endTime;
      const text = slice.map(w => w.word).join(' ');
      chunks.push(`${index}\n${start} --> ${end}\n${text}\n`);
    }

    return chunks.join('\n');
  }

  generateBilingualSRT(timedWords) {
    if (!timedWords || timedWords.length === 0) return '';
    const chunks = [];
    const wordsPerSubtitle = 6;

    for (let i = 0; i < timedWords.length; i += wordsPerSubtitle) {
      const slice = timedWords.slice(i, i + wordsPerSubtitle);
      const index = Math.floor(i / wordsPerSubtitle) + 1;
      const start = slice[0].startTime;
      const end = slice[slice.length - 1].endTime;
      const origText = slice.map(w => w.word).join(' ');
      const transText = slice.map(w => w.translation).join(' ');
      chunks.push(`${index}\n${start} --> ${end}\n${origText}\n${transText}\n`);
    }

    return chunks.join('\n');
  }

  generateVTT(timedWords) {
    let vtt = 'WEBVTT\n\n';
    const srt = this.generateSRT(timedWords);
    vtt += srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  }

  generateBilingualVTT(timedWords) {
    let vtt = 'WEBVTT\n\n';
    const srt = this.generateBilingualSRT(timedWords);
    vtt += srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  }
}

window.speechEngine = new SpeechEngine();
