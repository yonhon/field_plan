window.FIELD_PLAN_CONFIG = {
  supabaseUrl: "https://byhthaiwbutqstrqbwwc.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aHRoYWl3YnV0cXN0cnFid3djIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzk4NTgsImV4cCI6MjA5MTkxNTg1OH0.UeKltgs5l1JPbt5Gg0wpDzc5fZoLQTkBPwIV2H1WBzs",
  defaultFieldName: "圃場 1",
  // 下絵を読み込んだ直後の仮の縮尺（1 画素が何メートルか）。縮尺合わせで直す
  defaultMetersPerPixel: 0.1,
  // 防除の記録で、農薬の使用基準（FAMIC の農薬登録情報）を使うか。false にすると、この部分を外す（app/pesticide.js）
  famic: true,
};
