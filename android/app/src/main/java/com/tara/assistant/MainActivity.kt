package com.tara.assistant

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.telephony.SmsManager
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.json.JSONObject
import java.util.Locale

/**
 * TARA phone app: a WebView showing assets/index.html, plus a native bridge for
 * voice input (SpeechRecognizer), spoken replies (TextToSpeech), a "Hey TARA" wake-word
 * listener (while the app is open), and phone actions (call / SMS) that TARA on the PC can
 * request through the cloud relay. Every call/SMS is confirmed on the phone before it runs.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingLang: String? = null

    private var speaking = false
    private var speakStarted = 0L
    private var mode = ""            // "", "wake" or "manual"
    private var wakeOn = false
    private var wakeLang = "en-IN"
    private var pendingWake = false
    private var pendingSms: Triple<String, String, String>? = null   // id, number, text
    private var pendingCall: Pair<String, String>? = null            // id, number
    private val handler = Handler(Looper.getMainLooper())
    private val wakeRunnable = Runnable { wakeTick() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "Android")
        web.loadUrl("file:///android_asset/index.html")

        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) { handler.post { speaking = true; speakStarted = SystemClock.elapsedRealtime() } }
                override fun onDone(utteranceId: String?) { speechFinished() }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) { speechFinished() }
            })
        }
    }

    private fun speechFinished() {
        handler.post { speaking = false; scheduleWake(700) }
        js("onSpeakDone()")
    }

    private fun js(code: String) {
        runOnUiThread { web.evaluateJavascript(code, null) }
    }

    private fun q(s: String): String = JSONObject.quote(s)

    // ---------- wake word ("Hey TARA"): short listening cycles while the app is open ----------
    private fun scheduleWake(delay: Long) {
        handler.removeCallbacks(wakeRunnable)
        if (wakeOn) handler.postDelayed(wakeRunnable, delay)
    }

    private fun wakeTick() {
        if (!wakeOn) return
        if (speaking && SystemClock.elapsedRealtime() - speakStarted > 90000) speaking = false   // safety: TTS never reported done
        if (mode == "manual" || speaking) { handler.postDelayed(wakeRunnable, 800); return }
        beginListen(wakeLang, "wake")
    }

    private fun beginListen(lang: String, m: String) {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            val msg = "Speech recognition is not available. Install or enable the Google app / Speech Services."
            if (m == "wake") { wakeOn = false; mode = ""; js("onWakeState(false, ${q(msg)})") } else js("onSpeechError(${q(msg)})")
            return
        }
        mode = m
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { r ->
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { if (m == "manual") js("onSpeechState('listening')") }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { if (m == "manual") js("onSpeechState('processing')") }
                override fun onError(error: Int) {
                    if (mode == m) mode = ""
                    if (m == "wake") {
                        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                            wakeOn = false
                            js("onWakeState(false, ${q("Microphone permission is needed for Hey TARA.")})")
                            return
                        }
                        scheduleWake(if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) 1500 else 400)
                        return
                    }
                    val msg = when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I didn't catch that."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is needed."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network problem during speech recognition."
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy, try again."
                        else -> "Speech error ($error)."
                    }
                    js("onSpeechError(${q(msg)})")
                    scheduleWake(800)
                }
                override fun onResults(results: Bundle?) {
                    val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    if (mode == m) mode = ""
                    if (m == "wake") {
                        if (t.isNotEmpty()) js("onWakeResult(${q(t)})")
                        scheduleWake(400)
                    } else {
                        js("onSpeechResult(${q(t)}, true)")
                        scheduleWake(1000)
                    }
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    if (m != "manual") return
                    val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    if (t.isNotEmpty()) js("onSpeechResult(${q(t)}, false)")
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, m == "manual")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        recognizer?.startListening(intent)
    }

    private fun startListening(lang: String) = beginListen(lang, "manual")

    // ---------- phone actions (always confirmed on the phone screen before JS calls these) ----------
    private fun cleanNumber(n: String): String = n.filter { it.isDigit() || it == '+' }

    private fun smsComposer(id: String, number: String, text: String, note: String) {
        try {
            val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number))).putExtra("sms_body", text)
            startActivity(i)
            js("onCmdResult(${q(id)}, true, ${q(note)})")
        } catch (e: Exception) {
            js("onCmdResult(${q(id)}, false, ${q("Could not open the message app: " + (e.message ?: "unknown error"))})")
        }
    }

    @Suppress("DEPRECATION")
    private fun doSms(id: String, number: String, text: String) {
        try {
            val sm: SmsManager = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java)
            else SmsManager.getDefault()
            sm.sendMultipartTextMessage(number, null, sm.divideMessage(text), null, null)
            js("onCmdResult(${q(id)}, true, ${q("Text handed to the phone's SMS service (delivery is not confirmed).")})")
        } catch (e: Exception) {
            js("onCmdResult(${q(id)}, false, ${q("SMS failed: " + (e.message ?: "unknown error"))})")
        }
    }

    private fun dialer(id: String, number: String, note: String) {
        try {
            startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)))
            js("onCmdResult(${q(id)}, true, ${q(note)})")
        } catch (e: Exception) {
            js("onCmdResult(${q(id)}, false, ${q("Could not open the dialer: " + (e.message ?: "unknown error"))})")
        }
    }

    private fun doCall(id: String, number: String) {
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)))
            js("onCmdResult(${q(id)}, true, ${q("Call started.")})")
        } catch (e: Exception) {
            dialer(id, number, "Could not place the call directly, so I opened the dialer — tap call.")
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            1 -> {
                val lang = pendingLang
                pendingLang = null
                if (granted && lang != null) startListening(lang)
                else js("onSpeechError(${q("Microphone permission denied. Allow it in Android Settings > Apps > TARA.")})")
            }
            2 -> {
                val p = pendingSms; pendingSms = null
                if (p != null) {
                    if (granted) doSms(p.first, p.second, p.third)
                    else smsComposer(p.first, p.second, p.third, "SMS permission was denied, so I opened the message composer — tap send there.")
                }
            }
            3 -> {
                val p = pendingCall; pendingCall = null
                if (p != null) {
                    if (granted) doCall(p.first, p.second)
                    else dialer(p.first, p.second, "Call permission was denied, so I opened the dialer — tap call there.")
                }
            }
            4 -> {
                if (pendingWake) {
                    pendingWake = false
                    if (granted) scheduleWake(200)
                    else { wakeOn = false; js("onWakeState(false, ${q("Microphone permission denied, so Hey TARA is off.")})") }
                }
            }
        }
    }

    override fun onPause() {
        handler.removeCallbacks(wakeRunnable)
        if (mode == "wake") { recognizer?.cancel(); mode = "" }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (wakeOn) scheduleWake(600)
    }

    override fun onDestroy() {
        handler.removeCallbacks(wakeRunnable)
        recognizer?.destroy()
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    inner class Bridge {
        @JavascriptInterface
        fun listen(lang: String) {
            runOnUiThread {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingLang = lang
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
                } else {
                    startListening(lang)
                }
            }
        }

        @JavascriptInterface
        fun stopListening() {
            runOnUiThread { recognizer?.stopListening() }
        }

        @JavascriptInterface
        fun speak(text: String, lang: String) {
            runOnUiThread {
                if (!ttsReady) { js("onSpeakDone()"); return@runOnUiThread }
                if (mode == "wake") { recognizer?.cancel(); mode = "" }   // don't hear ourselves
                speaking = true; speakStarted = SystemClock.elapsedRealtime()
                tts?.language = Locale.forLanguageTag(lang)
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "tara")
            }
        }

        @JavascriptInterface
        fun stopSpeaking() {
            runOnUiThread { tts?.stop(); speaking = false; scheduleWake(500) }
        }

        @JavascriptInterface
        fun setWake(on: Boolean, lang: String) {
            runOnUiThread {
                wakeLang = lang
                if (on) {
                    wakeOn = true
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        pendingWake = true
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 4)
                    } else scheduleWake(200)
                } else {
                    wakeOn = false
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    handler.removeCallbacks(wakeRunnable)
                    if (mode == "wake") { recognizer?.cancel(); mode = "" }
                }
            }
        }

        @JavascriptInterface
        fun sendSms(id: String, number: String, text: String) {
            runOnUiThread {
                val n = cleanNumber(number)
                if (n.length < 5 || text.isBlank()) { js("onCmdResult(${q(id)}, false, ${q("Invalid number or empty text.")})"); return@runOnUiThread }
                if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
                    pendingSms = Triple(id, n, text)
                    requestPermissions(arrayOf(Manifest.permission.SEND_SMS), 2)
                } else doSms(id, n, text)
            }
        }

        @JavascriptInterface
        fun placeCall(id: String, number: String) {
            runOnUiThread {
                val n = cleanNumber(number)
                if (n.length < 5) { js("onCmdResult(${q(id)}, false, ${q("Invalid phone number.")})"); return@runOnUiThread }
                if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                    pendingCall = Pair(id, n)
                    requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), 3)
                } else doCall(id, n)
            }
        }
    }
}
