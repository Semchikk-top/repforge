import type { MuscleGroup } from './types';

const RAW: { name: string; muscle: MuscleGroup; equipment: string }[] = [
  { name: 'Жим штанги лёжа', muscle: 'chest', equipment: 'Штанга' },
  { name: 'Жим гантелей на наклонной скамье', muscle: 'chest', equipment: 'Гантели' },
  { name: 'Отжимания на брусьях', muscle: 'chest', equipment: 'Брусья' },
  { name: 'Разводка гантелей', muscle: 'chest', equipment: 'Гантели' },
  { name: 'Подтягивания', muscle: 'back', equipment: 'Турник' },
  { name: 'Тяга штанги в наклоне', muscle: 'back', equipment: 'Штанга' },
  { name: 'Тяга верхнего блока', muscle: 'back', equipment: 'Блок' },
  { name: 'Тяга нижнего блока', muscle: 'back', equipment: 'Блок' },
  { name: 'Тяга гантели одной рукой', muscle: 'back', equipment: 'Гантели' },
  { name: 'Становая тяга', muscle: 'back', equipment: 'Штанга' },
  { name: 'Приседания со штангой', muscle: 'legs', equipment: 'Штанга' },
  { name: 'Жим ногами', muscle: 'legs', equipment: 'Тренажёр' },
  { name: 'Выпады с гантелями', muscle: 'legs', equipment: 'Гантели' },
  { name: 'Разгибание ног', muscle: 'legs', equipment: 'Тренажёр' },
  { name: 'Сгибание ног', muscle: 'legs', equipment: 'Тренажёр' },
  { name: 'Румынская тяга', muscle: 'glutes', equipment: 'Штанга' },
  { name: 'Ягодичный мостик', muscle: 'glutes', equipment: 'Штанга' },
  { name: 'Жим стоя', muscle: 'shoulders', equipment: 'Штанга' },
  { name: 'Жим гантелей сидя', muscle: 'shoulders', equipment: 'Гантели' },
  { name: 'Махи гантелей в стороны', muscle: 'shoulders', equipment: 'Гантели' },
  { name: 'Тяга к лицу', muscle: 'shoulders', equipment: 'Блок' },
  { name: 'Подъём штанги на бицепс', muscle: 'biceps', equipment: 'Штанга' },
  { name: 'Молотки', muscle: 'biceps', equipment: 'Гантели' },
  { name: 'Французский жим', muscle: 'triceps', equipment: 'Штанга' },
  { name: 'Разгибание на блоке', muscle: 'triceps', equipment: 'Блок' },
  { name: 'Скручивания', muscle: 'core', equipment: 'Свой вес' },
  { name: 'Планка', muscle: 'core', equipment: 'Свой вес' },
  { name: 'Подъём ног в висе', muscle: 'core', equipment: 'Турник' },
  { name: 'Подъём на носки стоя', muscle: 'calves', equipment: 'Тренажёр' },
  { name: 'Бег', muscle: 'cardio', equipment: 'Улица, дорожка' },
  // новые стартовые упражнения только в конец: id зависят от порядка
  { name: 'Ходьба', muscle: 'cardio', equipment: 'Улица, дорожка' },
  { name: 'Велосипед', muscle: 'cardio', equipment: 'Улица, велотренажёр' }
];

// Id стартовых упражнений одинаковы на всех устройствах — иначе после синхронизации появились бы дубли.
export const SEED_EXERCISES = RAW.map((e, i) => ({ ...e, id: `seed-${String(i + 1).padStart(3, '0')}` }));
