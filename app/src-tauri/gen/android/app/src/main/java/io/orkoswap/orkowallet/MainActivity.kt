package io.orkoswap.orkowallet

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  /** True while a wallet is open: the foreground service runs and Back sends the app to the background. */
  private var keepAlive = false
  private var svcTitle = "OrkoWallet"
  private var svcText = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    webView.addJavascriptInterface(Bridge(), "OrkoAndroid")
  }

  /** Called from the page (window.OrkoAndroid) when a wallet is opened or closed. */
  inner class Bridge {
    @JavascriptInterface
    fun serviceOn(title: String, text: String) {
      runOnUiThread { startKeepAlive(title, text) }
    }

    @JavascriptInterface
    fun serviceOff() {
      runOnUiThread { stopKeepAlive() }
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
    val i = Intent(this, OrkoService::class.java).putExtra("title", svcTitle).putExtra("text", svcText)
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
}
