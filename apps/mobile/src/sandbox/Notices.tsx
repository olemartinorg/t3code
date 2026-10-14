import { ScrollView, Text, Button } from "react-native";
import { useNavigation } from "@react-navigation/native";
const upstreamLicense =
  'MIT License\n\nCopyright (c) 2026 T3 Tools Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n';
export function Notices() {
  const navigation = useNavigation();
  return (
    <ScrollView
      style={{ backgroundColor: "#09090b" }}
      contentContainerStyle={{ padding: 24, paddingTop: 40, gap: 14 }}
    >
      <Text style={{ color: "#fff", fontSize: 24 }}>Sandbox companion</Text>
      <Text style={{ color: "#fff" }}>
        This experimental app uses T3 native mobile source. It has a separate application identity
        and no T3 Connect login or upstream OTA channel.
      </Text>
      <Text style={{ color: "#fff" }}>{upstreamLicense}</Text>
      <Button
        title="Third-party notices"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsOpenSourceLicenses" },
          })
        }
      />
    </ScrollView>
  );
}
