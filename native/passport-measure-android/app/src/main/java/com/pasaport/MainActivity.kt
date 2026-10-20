package com.pasaport

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

private sealed interface State {
    data object Idle : State
    data object Measuring : State
    data class Done(val passport: Passport) : State
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Screen(
                    keepScreenOn = { on ->
                        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                )
            }
        }
    }
}

@Composable
private fun Screen(keepScreenOn: (Boolean) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<State>(State.Idle) }

    val measuring = state is State.Measuring
    DisposableEffect(measuring) {
        keepScreenOn(measuring)
        onDispose { keepScreenOn(false) }
    }

    fun startMeasure() {
        if (measuring) return
        state = State.Measuring
        scope.launch { state = State.Done(measureAll(context.applicationContext)) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .systemBarsPadding()
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "Kapasite Pasaportu",
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(16.dp))

        Box(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            when (val s = state) {
                State.Idle -> Button(
                    onClick = ::startMeasure,
                    shape = CircleShape,
                    modifier = Modifier.size(180.dp),
                ) {
                    Text("ÖLÇ", fontSize = 32.sp, fontWeight = FontWeight.Bold)
                }

                State.Measuring -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(modifier = Modifier.size(72.dp))
                    Spacer(Modifier.height(16.dp))
                    Text("Ölçülüyor…", color = MaterialTheme.colorScheme.onBackground)
                }

                is State.Done -> ResultCard(s.passport) { copyJson(context, s.passport) }
            }
        }

        if (state is State.Done) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = ::startMeasure, modifier = Modifier.fillMaxWidth()) {
                Text("Yenile")
            }
        }
    }
}

@Composable
private fun ResultCard(p: Passport, onCopy: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                InfoRow("Cihaz", p.device)
                InfoRow("SoC", p.soc)
                InfoRow("Android", p.android)
                InfoRow("RAM toplam / boş", "${p.ramTotalGb} / ${p.ramFreeGb} GB")
                InfoRow("Uygulama bellek tavanı", "${p.appMemCapMb} MB")
                InfoRow("CPU", "${p.cpuCores} çekirdek, ${p.cpuMaxGhz} GHz")
                InfoRow("Bellek bant genişliği", "${p.memBwGbs} GB/s")
                InfoRow("İşlem gücü", "${p.gflops} GFLOPS")
                InfoRow("Boş depolama", "${p.storageFreeGb} GB")
                InfoRow("Pil", "%${p.batteryPct}" + if (p.charging) " (şarjda)" else "")
                InfoRow("En büyük model (Q4)", "${p.largestModelQ4}, ~${p.estTps} token/s")
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            "JSON kopyala",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clickable(onClick = onCopy).padding(6.dp),
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
        Spacer(Modifier.size(12.dp))
        Text(
            value,
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

private fun copyJson(context: Context, p: Passport) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("passport", p.toJson()))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(context, "Kopyalandı", Toast.LENGTH_SHORT).show()
    }
}
