import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppComponent } from './app.component';
import { ConnectionPanelComponent } from './components/connection-panel/connection-panel.component';
import { MovementPadComponent } from './components/movement-pad/movement-pad.component';
import { EmotionPanelComponent } from './components/emotion-panel/emotion-panel.component';
import { LogConsoleComponent } from './components/log-console/log-console.component';
import { DogDisplayComponent } from './components/dog-display/dog-display.component';
import { DigitalTwinComponent } from './components/digital-twin/digital-twin.component';

@NgModule({
  declarations: [
    AppComponent,
    ConnectionPanelComponent,
    MovementPadComponent,
    EmotionPanelComponent,
    LogConsoleComponent,
    DogDisplayComponent,
    DigitalTwinComponent,
  ],
  imports: [
    BrowserModule,
    FormsModule,
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule {}
