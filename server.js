// src/screens/SettingsScreen.js
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { colors, fonts, radius } from '../utils/theme';
import { JOB_STATUSES } from '../components/AddAppointmentModal';

const DEFAULT_NAME = 'RL Small Engines';

const formatDateFull = (dt) => {
  if (!dt) return '';
  const d = new Date(dt);
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

// Use the saved status field; fall back to date-based label for old records
const getStatusLabel = (appt) => {
  if (appt.status) {
    const meta = JOB_STATUSES.find((s) => s.key === appt.status);
    return meta ? meta.label : appt.status;
  }
  if (appt.completed) return 'Completed';
  if (appt.dateTime && new Date(appt.dateTime) < new Date()) return 'Past';
  return 'Upcoming';
};

const csvField = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

export default function SettingsScreen({ businessName, onBusinessNameChange, appointments }) {
  const [draft, setDraft] = useState(businessName);
  const [exporting, setExporting] = useState(false);

  const handleSave = () => {
    const trimmed = draft.trim() || DEFAULT_NAME;
    onBusinessNameChange(trimmed);
    setDraft(trimmed);
    Alert.alert('Saved', `Business name updated to "${trimmed}"`);
  };

  const handleReset = () => {
    Alert.alert('Reset to Default', `Reset business name to "${DEFAULT_NAME}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        onPress: () => {
          setDraft(DEFAULT_NAME);
          onBusinessNameChange(DEFAULT_NAME);
        },
      },
    ]);
  };

  const handleExport = async () => {
    if (!appointments || appointments.length === 0) {
      Alert.alert('No Data', 'There are no appointments to export.');
      return;
    }

    setExporting(true);
    try {
      const headers = [
        'Customer Name',
        'Phone',
        'Address',
        'City',
        'State',
        'Zip',
        'Job Type',
        'Date & Time',
        'Job Status',
        'Completed Date',
        'Notes',
      ];

      const rows = appointments.map((a) => {
        const completedDate = a.completedAt
          ? new Date(a.completedAt).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })
          : '';
        return [
          csvField(a.name),
          csvField(a.phone),
          csvField(a.address),
          csvField(a.city),
          csvField(a.state),
          csvField(a.zip),
          csvField(a.jobType),
          csvField(formatDateFull(a.dateTime)),
          csvField(getStatusLabel(a)),
          csvField(completedDate),
          csvField(a.notes),
        ].join(',');
      });

      const csv = [headers.map(csvField).join(','), ...rows].join('\n');

      const date = new Date().toISOString().slice(0, 10);
      const filename = `${businessName.replace(/\s+/g, '_')}_appointments_${date}.csv`;
      const fileUri = FileSystem.documentDirectory + filename;

      await FileSystem.writeAsStringAsync(fileUri, csv, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Appointments CSV',
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        Alert.alert('Exported', `File saved to:\n${fileUri}`);
      }
    } catch (e) {
      console.log('Export error:', e);
      Alert.alert('Export Failed', 'Something went wrong. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const hasChanges = draft.trim() !== businessName;

  // Status counts for export meta
  const statusCounts = JOB_STATUSES.map((s) => ({
    ...s,
    count: appointments?.filter((a) => a.status === s.key).length ?? 0,
  }));

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        {/* Business name section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>BUSINESS NAME</Text>
          <Text style={styles.sectionSub}>
            Shown in the app header across all screens
          </Text>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Enter your business name"
            placeholderTextColor={colors.textMuted}
            maxLength={40}
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />
          <Text style={styles.charCount}>{draft.length}/40</Text>

          <TouchableOpacity
            style={[styles.saveBtn, !hasChanges && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!hasChanges}
          >
            <Text style={[styles.saveBtnTxt, !hasChanges && styles.saveBtnTxtDisabled]}>
              Save Name
            </Text>
          </TouchableOpacity>

          {businessName !== DEFAULT_NAME && (
            <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
              <Text style={styles.resetTxt}>Reset to default</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Preview */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>PREVIEW</Text>
          <View style={styles.previewBar}>
            <Text style={styles.previewTitle}>{draft.trim() || DEFAULT_NAME}</Text>
          </View>
        </View>

        {/* Export section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>EXPORT DATA</Text>
          <Text style={styles.sectionSub}>
            Export all appointments to a CSV file you can open in Excel
          </Text>

          {/* Status breakdown */}
          <View style={styles.exportMeta}>
            <Text style={styles.exportTotal}>
              📋 {appointments?.length ?? 0} total
            </Text>
            <View style={styles.statusBreakdown}>
              {statusCounts.map((s) => (
                <View key={s.key} style={styles.statusCount}>
                  <Text style={[styles.statusCountNum, { color: s.color }]}>{s.count}</Text>
                  <Text style={styles.statusCountLbl}>{s.emoji} {s.label}</Text>
                </View>
              ))}
            </View>
          </View>

          <TouchableOpacity
            style={[styles.exportBtn, exporting && styles.exportBtnDisabled]}
            onPress={handleExport}
            disabled={exporting}
          >
            <Text style={styles.exportBtnTxt}>
              {exporting ? 'Exporting…' : '📤 Export to CSV'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* App info */}
        <View style={styles.infoSection}>
          <Text style={styles.infoTxt}>RL Scheduler</Text>
          <Text style={styles.infoSub}>Small engine repair scheduling app</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  section: {
    margin: 16,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: 16,
  },
  sectionLabel: {
    color: colors.accent,
    fontSize: fonts.sm,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  sectionSub: {
    color: colors.textMuted,
    fontSize: fonts.sm,
    marginBottom: 14,
  },

  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 12,
    color: colors.text,
    fontSize: fonts.lg,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: colors.border,
  },
  charCount: {
    color: colors.textMuted,
    fontSize: fonts.sm,
    textAlign: 'right',
    marginTop: 4,
    marginBottom: 12,
  },

  saveBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    padding: 13,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: colors.border },
  saveBtnTxt: { color: colors.white, fontSize: fonts.base, fontWeight: '700' },
  saveBtnTxtDisabled: { color: colors.textMuted },

  resetBtn: { alignItems: 'center', marginTop: 12 },
  resetTxt: { color: colors.textMuted, fontSize: fonts.sm },

  previewBar: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  previewTitle: { color: colors.text, fontSize: fonts.lg, fontWeight: '700' },

  // Export
  exportMeta: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14,
  },
  exportTotal: {
    color: colors.text,
    fontSize: fonts.md,
    fontWeight: '600',
    marginBottom: 10,
  },
  statusBreakdown: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statusCount: { alignItems: 'center' },
  statusCountNum: { fontSize: fonts.lg, fontWeight: '700' },
  statusCountLbl: { color: colors.textMuted, fontSize: fonts.sm, marginTop: 2 },

  exportBtn: {
    backgroundColor: '#1565c0',
    borderRadius: radius.md,
    padding: 13,
    alignItems: 'center',
  },
  exportBtnDisabled: { backgroundColor: colors.border },
  exportBtnTxt: { color: colors.white, fontSize: fonts.base, fontWeight: '700' },

  infoSection: { alignItems: 'center', marginTop: 24, marginBottom: 40 },
  infoTxt: { color: colors.textMuted, fontSize: fonts.sm, fontWeight: '600' },
  infoSub: { color: colors.textMuted, fontSize: fonts.sm, marginTop: 2 },
});
