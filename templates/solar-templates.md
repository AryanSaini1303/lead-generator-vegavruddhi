* [ ] 

# Solar offer: Hinglish template drafts

Submit in WhatsApp Manager > Message templates. Settings for all three:

- **Category:** Marketing
- **Language:** English (Hinglish in Roman script is submitted under English)
- **Buttons:** Quick reply x3, **in this order: Yes, No, Stop** (the code attaches payloads YES / NO / STOP by position)
- **Variable:** `{{1}}` = first name. Meta needs a sample value, e.g. `Rahul`. Variables can't be the first or last thing in the body, so every draft starts and ends with plain text.
- Fill in `[Solar Company]` and the claims in `[brackets]` with facts the partner can stand behind. Meta rejects vague or misleading promises, and so do customers.
- Keep the consent line (your number is shared with the partner). It is what makes the "Yes" tap a valid opt-in to be called.

---

# Solar offer: partner's version (Hindi) <- use this one

Adapted from the copy your partner sent. What I changed and why:

- `[ग्राहक का नाम]` -> `{{1}}` (Meta's variable syntax; sample value e.g. `राहुल`).
- Added one line saying the message comes **from Vegavruddhi**. Without it, people don't recognise the sender and tap Block, which hurts the number's quality rating.
- Added the consent line ("हाँ" shares name and number with SolarSquare). It makes the tap a valid opt-in.
- Removed the brackets around SolarSquare, and the body now ends with plain text (Meta rejects a variable or button text as the first/last thing).
- Softened nothing that was already hedged; added "(पात्रता अनुसार)" to the subsidy line.

**Settings:** Category Marketing | **Language: Hindi (`hi`)** | set `TEMPLATE_LANG=hi` in `.env`

**Body** (647 of 1024 characters)

```
नमस्ते {{1}} जी! 🙏

SolarSquare के साथ अपने घर की छत पर सोलर लगवाएँ और पाएँ शानदार फायदे!

✅ बिजली बिल लगभग ज़ीरो तक लाने की संभावना
💰 अतिरिक्त सोलर बिजली से कमाई या बिल में क्रेडिट का मौका
🎁 घरों के लिए ₹78,000 तक की केंद्रीय सरकारी सब्सिडी (पात्रता अनुसार)
⚡ शर्तों के अनुसार बिजली उत्पादन की गारंटी
🛡️ सोलर सिस्टम पर वारंटी और विशेषज्ञ सहायता

🏡 FREE HOME VISIT!

SolarSquare की तकनीकी टीम आपके घर आकर सोलर की लागत, सब्सिडी और संभावित बचत की पूरी जानकारी देगी।

👉 क्या आप FREE HOME VISIT चाहते हैं?
```

**Footer** (36 of 60)

```
मैसेज बंद करने के लिए नीचे बटन दबाएँ
```

**Buttons** (quick reply, this order: Yes, No, Stop; max 25 characters each)

```
हाँ, चाहिए | नहीं, धन्यवाद | मैसेज बंद करें
```

**Header (optional):** an image of a rooftop solar installation lifts response noticeably. Use a photo SolarSquare has given you permission to use.

## Check with the partner before submitting

- **Claims:** "लगभग ज़ीरो बिल", "₹78,000 तक सब्सिडी" and "उत्पादन की गारंटी" must be things SolarSquare can back up. Meta can reject unsubstantiated promises, and Indian ad rules (ASCI) require proof.
- **Brand permission:** confirm SolarSquare has agreed in writing to be named and to receive these leads.
- **Sample value:** Meta asks for an example of `{{1}}` at submission.

---

# Earlier Hinglish drafts (optional alternatives)

## Draft A: warm, detailed

**Body**

```
Namaste {{1}} ji 🙏

Vegavruddhi se bol rahe hain. Humse judne ke liye aapka shukriya!

Kya aap apne ghar ya dukaan ka bijli bill kam karna chahte hain? ☀️ Hamare partner [Solar Company] solar panel lagate hain, jisse bill mein kaafi bachat ho sakti hai aur [sarkari subsidy] ka bhi fayda mil sakta hai.

Free consultation chahiye toh "Haan, bataiye" dabayein. Aapka naam aur number sirf [Solar Company] ke saath share hoga, taaki unki team aapko call kar sake.
```

**Footer:** `Messages band karne ke liye Stop dabayein`
**Buttons:** `Haan, bataiye` | `Abhi nahi` | `Stop`

---

## Draft B: short and punchy

**Body**

```
Namaste {{1}} ji! ☀️

Bijli ka bill har mahine badh raha hai? Solar se yeh kaafi kam ho sakta hai!

Vegavruddhi ke partner [Solar Company] free site visit aur quote de rahe hain. Interested hain? "Haan" dabane par aapka number unke saath share hoga.
```

**Footer:** `Band karne ke liye Stop dabayein`
**Buttons:** `Haan, interested` | `Nahi, shukriya` | `Stop`

---

## Draft C: question hook

**Body**

```
Namaste {{1}} ji,

Ek chhota sawaal: agar aapka bijli bill kaafi kam ho jaye, toh kaisa lagega? 😄

Solar panel se yeh mumkin hai. Vegavruddhi ke partner [Solar Company] free consultation de rahe hain, bina kisi zimmedari ke. Chahein toh "Haan" dabayein; hum aapka naam aur number unke saath share karenge taaki woh aapse sampark kar sakein.
```

**Footer:** `Messages band karne ke liye Stop dabayein`
**Buttons:** `Haan, call karein` | `Abhi nahi` | `Stop`

---

## Pilot tip

Submit A and B, and send each to half of the first 500. Whichever gets the better yes-rate and fewer Stop taps wins the next batch. To switch template, change `TEMPLATE_NAME` in `.env`.
