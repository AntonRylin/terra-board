package terra.board.android;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

// Landscape gives the board the whole screen: the status bar (time, battery) and the
// navigation buttons hide (a swipe from the edge shows them for a moment), and the board
// also uses the side with the camera hole. Portrait keeps the bars and stays clear of them.
// capacitor.config.json turns Capacitor's own inset padding off (SystemBars insetsHandling
// "disable"); this activity pads instead.
public class MainActivity extends BridgeActivity {
    private static final int BARS = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            int ime = keyboard ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            if (landscape()) {
                view.setPadding(0, 0, 0, ime);
            } else {
                Insets bars = insets.getInsets(BARS);
                view.setPadding(bars.left, bars.top, bars.right, keyboard ? ime : bars.bottom);
            }
            // The page keeps clear of nothing: portrait is padded here, and in landscape the
            // board uses every edge, camera hole included. Otherwise its safe-area margins
            // (styles.css, html.android) would leave white strips.
            return new WindowInsetsCompat.Builder(insets).setInsets(BARS, Insets.NONE).build();
        });
        fitBars();
    }

    // The activity handles turning itself (configChanges in AndroidManifest.xml).
    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        fitBars();
    }

    // Coming back from another app can bring the bars back.
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) fitBars();
    }

    private boolean landscape() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
    }

    private void fitBars() {
        View decor = getWindow().getDecorView();
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (landscape()) bars.hide(WindowInsetsCompat.Type.systemBars());
        else bars.show(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(decor);
    }
}
