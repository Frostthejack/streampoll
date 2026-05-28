// settings.rs — App settings persistence
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomColors {
    pub bar_fill: String,
    pub bar_bg: String,
    pub text_color: String,
    pub background: String,
    pub accent: String,
}

impl Default for CustomColors {
    fn default() -> Self {
        Self {
            bar_fill: "#6c63ff".to_string(),
            bar_bg: "rgba(255,255,255,0.1)".to_string(),
            text_color: "#ffffff".to_string(),
            background: "rgba(15,15,30,0.85)".to_string(),
            accent: "#a78bfa".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedTheme {
    pub id: String,
    pub name: String,
    pub theme: String,
    pub custom_colors: CustomColors,
    pub custom_font: String,
    pub overlay_opacity: f32,
    pub custom_bg_image: String,
    pub bar_animations: bool,
    pub theme_effects: bool,
    pub layout_mode: String,
    pub effect_speed: f32,
    pub effect_strength: f32,
    pub global_overlay: String,
    pub global_overlay_color: String,
}

impl Default for SavedTheme {
    fn default() -> Self {
        Self {
            id: "default_id".to_string(),
            name: "Unnamed Theme".to_string(),
            theme: "glassmorphism".to_string(),
            custom_colors: CustomColors::default(),
            custom_font: "Inter".to_string(),
            overlay_opacity: 0.9,
            custom_bg_image: "".to_string(),
            bar_animations: true,
            theme_effects: true,
            layout_mode: "standard".to_string(),
            effect_speed: 1.0,
            effect_strength: 1.0,
            global_overlay: "none".to_string(),
            global_overlay_color: "#ffffff".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub theme: String,
    pub custom_colors: CustomColors,
    pub custom_font: String,
    pub font_size: u32,
    pub options_font_size: u32,
    pub bar_height: u32,
    pub overlay_opacity: f32,
    pub always_on_top: bool,
    pub click_through: bool,
    pub click_through_keybind: String,
    pub show_percentages: bool,
    pub show_vote_counts: bool,
    pub show_question: bool,
    pub client_id: String,
    pub client_secret: String,
    pub custom_bg_image: String,
    pub custom_bar_bg_image: String,
    pub custom_bar_fill_image: String,
    pub custom_banner_image: String,
    pub bar_animations: bool,
    pub theme_effects: bool,
    pub layout_mode: String,
    pub effect_speed: f32,
    pub effect_strength: f32,
    pub global_overlay: String,
    pub global_overlay_color: String,
    pub saved_themes: Vec<SavedTheme>,
    pub theme_overrides: std::collections::HashMap<String, SavedTheme>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "glassmorphism".to_string(),
            custom_colors: CustomColors::default(),
            custom_font: "Inter".to_string(),
            font_size: 16,
            options_font_size: 14,
            bar_height: 20,
            overlay_opacity: 0.9,
            always_on_top: false,
            click_through: false,
            click_through_keybind: "Ctrl+Alt+O".to_string(),
            show_percentages: true,
            show_vote_counts: true,
            show_question: true,
            client_id: "".to_string(),
            client_secret: "".to_string(),
            custom_bg_image: "".to_string(),
            custom_bar_bg_image: "".to_string(),
            custom_bar_fill_image: "".to_string(),
            custom_banner_image: "".to_string(),
            bar_animations: true,
            theme_effects: true,
            layout_mode: "standard".to_string(),
            effect_speed: 1.0,
            effect_strength: 1.0,
            global_overlay: "none".to_string(),
            global_overlay_color: "#ffffff".to_string(),
            saved_themes: Vec::new(),
            theme_overrides: std::collections::HashMap::new(),
        }
    }
}
