package io.orkoswap.orkowallet

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.webkit.JavascriptInterface
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  /** True while a wallet is open: the foreground service runs and Back sends the app to the background. */
  private var keepAlive = false
  private var svcTitle = "OrkoWallet"
  private var svcText = ""
  private var svcClose = "Close wallet"
  private var web: WebView? = null
  private var quitting = false
  private val bio by lazy { BioLock(this) }

  /** Answer a fingerprint request in the page: window.orkoBio(reqId, {ok, secret}). */
  private fun bioReply(req: String, ok: Boolean, secret: String? = null) {
    val o = JSONObject().put("ok", ok).put("secret", secret ?: "")
    runOnUiThread { web?.evaluateJavascript("window.orkoBio && window.orkoBio(" + JSONObject.quote(req) + "," + o + ")", null) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    current = WeakReference(this)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (keepAlive) {
          moveTaskToBack(true) // keep receiving payments instead of closing the wallet
        } else {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(Bridge(), "OrkoAndroid")
  }

  override fun onDestroy() {
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  /**
   * "Close wallet" in the notification: the page closes the wallet and Tor cleanly (window.orkoQuit, which
   * calls back exitApp()). If the page does not answer in time, the app is ended anyway.
   */
  fun quitFromNotification() {
    if (quitting) return
    quitting = true
    val w = web
    if (w == null) { exitNow(); return }
    w.evaluateJavascript("window.orkoQuit ? (window.orkoQuit(), 1) : 0") { r ->
      if (r != "1") exitNow()
    }
    Handler(Looper.getMainLooper()).postDelayed({ exitNow() }, 12_000)
  }

  private fun exitNow() {
    keepAlive = false
    stopService(Intent(this, OrkoService::class.java))
    finishAndRemoveTask()
    // The wallet and Tor were shut down by the page (or did not answer); end the process so nothing keeps running.
    Handler(Looper.getMainLooper()).postDelayed({ Process.killProcess(Process.myPid()) }, 300)
  }

  /** Called from the page (window.OrkoAndroid) when a wallet is opened or closed. */
  inner class Bridge {
    @JavascriptInterface
    fun serviceOn(title: String, text: String) {
      runOnUiThread { startKeepAlive(title, text) }
    }

    /** Same, with the (translated) label of the notification's "Close wallet" button. */
    @JavascriptInterface
    fun serviceStart(title: String, text: String, closeLabel: String) {
      runOnUiThread { svcClose = closeLabel; startKeepAlive(title, text) }
    }

    /**
     * Start the app again in a fresh process (network change, connection repair): the grin libraries keep
     * the network in process-wide state, so a new process is the only clean way. The new task is queued
     * first, then this process ends; Android starts a new one for the queued activity.
     */
    @JavascriptInterface
    fun restartApp() {
      runOnUiThread {
        keepAlive = false
        stopService(Intent(this@MainActivity, OrkoService::class.java))
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.component
        if (launch != null) startActivity(Intent.makeRestartActivityTask(launch))
        Handler(Looper.getMainLooper()).postDelayed({ Process.killProcess(Process.myPid()) }, 200)
      }
    }

    /** The page has closed the wallet for good: stop the service and end the app. */
    @JavascriptInterface
    fun exitApp() {
      runOnUiThread { exitNow() }
    }

    /**
     * Open a block-explorer page in the system browser. Only Grin Scan kernel pages are accepted, so the
     * page cannot use this to open anything else.
     */
    @JavascriptInterface
    fun openUrl(url: String): Boolean {
      if (!KERNEL_URL.matches(url)) return false
      return try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (e: Exception) {
        false
      }
    }

    /** Fingerprint unlock (see BioLock): is it usable on this phone, is it set up for this wallet. */
    @JavascriptInterface
    fun bioAvailable(): Boolean = try { bio.available() } catch (e: Exception) { false }

    @JavascriptInterface
    fun bioHas(id: String): Boolean = try { bio.has(id) } catch (e: Exception) { false }

    @JavascriptInterface
    fun bioRemove(id: String) { try { bio.remove(id) } catch (_: Exception) { } }

    /** Store the wallet password behind the fingerprint. The answer comes back through window.orkoBio. */
    @JavascriptInterface
    fun bioEnroll(req: String, id: String, secret: String, title: String, cancel: String) {
      runOnUiThread { bio.enroll(id, secret, title, cancel) { ok -> bioReply(req, ok) } }
    }

    /** Ask for the fingerprint and hand back the stored password. */
    @JavascriptInterface
    fun bioUnlock(req: String, id: String, title: String, cancel: String) {
      runOnUiThread { bio.unlock(id, title, cancel) { s -> bioReply(req, s != null, s) } }
    }

    @JavascriptInterface
    fun serviceOff() {
      runOnUiThread { stopKeepAlive() }
    }

    /** Text on the clipboard (the WebView may refuse navigator.clipboard.readText); empty if there is none. */
    @JavascriptInterface
    fun readClipboard(): String {
      val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
    }

    /** While the recovery phrase is on screen: no screenshots, no screen recording, no recents preview. */
    @JavascriptInterface
    fun setSecure(on: Boolean) {
      runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
  }

  private fun startKeepAlive(title: String, text: String) {
    svcTitle = title
    svcText = text
    // Android 13+: the notification permission is a runtime question. The service runs without it,
    // but its notification (and payment notifications) stay hidden until it is granted.
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
    }
    launchService()
    keepAlive = true
  }

  private fun launchService() {
    val i = Intent(this, OrkoService::class.java).putExtra("title", svcTitle).putExtra("text", svcText).putExtra("close", svcClose)
    ContextCompat.startForegroundService(this, i)
  }

  // A foreground service started before the notification permission was granted keeps its notification
  // hidden even after the grant, so post it again once the user has answered.
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == 7 && keepAlive && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      launchService()
    }
  }

  private fun stopKeepAlive() {
    keepAlive = false
    stopService(Intent(this, OrkoService::class.java))
  }

  companion object {
    /** The running activity, for the notification's "Close wallet" button (null when there is none). */
    @Volatile var current: WeakReference<MainActivity>? = null
    private val KERNEL_URL = Regex("""^https://scan\.grin\.money/kernel/[0-9a-f]{8,130}$""")
  }
}
